import {
  vertex,
  simulation,
  blur,
  display,
} from "./vapour-shaders.js?v=preview-clear-1";

export function mountVapour(canvas, options = {}) {
  const host = options.host || document.documentElement;
  const scene = options.scene;
  if (!scene) throw new Error("Vapour needs a scene");
  const intensity = Math.max(0, Math.min(2, options.intensity ?? 1));
  const lifetime = Math.max(0.5, Math.min(2, options.lifetime ?? 1.2));
  const refraction = Math.max(0, Math.min(2, options.refraction ?? 1));
  const flowSpeed = Math.max(0.2, Math.min(1.5, options.flowSpeed ?? 0.7));
  const minRadius = Math.max(1, Math.min(12, options.minRadius ?? 6));
  // The renderer and CPU stop condition share the same invisible threshold.
  const visibilityRange = [0.003, 0.03];
  const attributes = {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  };
  const gl =
    canvas.getContext("webgl2", attributes) ||
    canvas.getContext("webgl", attributes);
  if (!gl) throw new Error("WebGL unavailable");
  const webgl2 = typeof gl.texStorage2D === "function";
  const byteStorage = {
    type: gl.UNSIGNED_BYTE,
    internal: gl.RGBA,
    neutral: 128 / 255,
    minimumChange: 0.004,
    rounding: 0.5 / 255,
  };
  let storage = byteStorage;
  if (webgl2 && gl.getExtension("EXT_color_buffer_float")) {
    storage = {
      type: gl.HALF_FLOAT,
      internal: gl.RGBA16F,
      neutral: 0.5,
      minimumChange: 0,
      relativeRounding: 1 / 1024,
      absoluteRounding: 1 / 16777216,
    };
  } else if (!webgl2) {
    const half = gl.getExtension("OES_texture_half_float");
    const linear = gl.getExtension("OES_texture_half_float_linear");
    const renderable = gl.getExtension("EXT_color_buffer_half_float");
    if (half && linear && renderable)
      storage = {
        type: half.HALF_FLOAT_OES,
        internal: gl.RGBA,
        neutral: 0.5,
        minimumChange: 0,
        relativeRounding: 1 / 1024,
        absoluteRounding: 1 / 16777216,
      };
  }

  const programs = [],
    shaders = [],
    removeListeners = [];
  let targets = [],
    flowTargets = [];
  let geometry = null,
    sceneTexture = null;
  let sim, soften, view, resizeObserver, visibilityObserver, contentObserver;
  let width = 1,
    height = 1,
    cssWidth = 1,
    cssHeight = 1;
  let frame = 0,
    previousTime = 0,
    accumulator = 0,
    energy = 0;
  let scrollY = window.scrollY,
    scrollOffset = 0;
  let onScreen = false,
    disposed = false,
    sceneDirty = true,
    hoverTarget = null;
  const stepSeconds = 1 / 60;
  const decay = [0.975, 0.95, 0.8].map((value) =>
    Math.pow(value, 1 / lifetime),
  );
  const pointer = {
    x: 0.5,
    y: 0.5,
    targetX: 0.5,
    targetY: 0.5,
    mx: 0,
    my: 0,
    radius: 0,
    inside: false,
  };

  function listen(target, event, handler, settings) {
    target.addEventListener(event, handler, settings);
    removeListeners.push(() =>
      target.removeEventListener(event, handler, settings),
    );
  }

  function program(fragment) {
    const p = gl.createProgram();
    if (!p) throw new Error("Cannot create vapour program");
    programs.push(p);
    const precision = gl.getShaderPrecisionFormat(
      gl.FRAGMENT_SHADER,
      gl.HIGH_FLOAT,
    );
    let fragmentSource = precision?.precision
      ? fragment
      : fragment.replace("precision highp", "precision mediump");
    let vertexSource = vertex;
    if (webgl2) {
      vertexSource =
        "#version 300 es\n" +
        vertex.replace(/\battribute\b/g, "in").replace(/\bvarying\b/g, "out");
      fragmentSource =
        "#version 300 es\n" +
        fragmentSource
          .replace(/\bvarying\b/g, "in")
          .replace(/\btexture2D\b/g, "texture")
          .replace(/\bgl_FragColor\b/g, "outColour")
          .replace("void main()", "out vec4 outColour;\nvoid main()");
    }
    for (const [type, code] of [
      [gl.VERTEX_SHADER, vertexSource],
      [gl.FRAGMENT_SHADER, fragmentSource],
    ]) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Cannot create vapour shader");
      shaders.push(shader);
      gl.shaderSource(shader, code);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error("Cannot compile vapour shader");
      gl.attachShader(p, shader);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error("Cannot link vapour program");
    const uniforms = {};
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
      const { name } = gl.getActiveUniform(p, i);
      uniforms[name] = gl.getUniformLocation(p, name);
    }
    return { p, uniforms, position: gl.getAttribLocation(p, "a_position") };
  }

  function texture() {
    const result = gl.createTexture();
    if (!result) throw new Error("Cannot create vapour texture");
    gl.bindTexture(gl.TEXTURE_2D, result);
    for (const key of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.texParameteri(gl.TEXTURE_2D, key, gl.LINEAR);
    for (const key of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
      gl.texParameteri(gl.TEXTURE_2D, key, gl.CLAMP_TO_EDGE);
    return result;
  }

  function target(w, h, collection) {
    const result = {
      texture: texture(),
      framebuffer: null,
      width: w,
      height: h,
    };
    collection.push(result);
    result.framebuffer = gl.createFramebuffer();
    if (!result.framebuffer) throw new Error("Cannot create vapour buffer");
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      storage.internal,
      w,
      h,
      0,
      gl.RGBA,
      storage.type,
      null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, result.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      result.texture,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error("Vapour buffer unavailable");
  }

  function freeTargets() {
    for (const target of [...targets, ...flowTargets]) {
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    }
    targets = [];
    flowTargets = [];
  }

  function allocateTargets() {
    for (let i = 0; i < 2; i++) {
      target(width, height, targets);
      target(
        Math.max(2, Math.ceil(width / 2)),
        Math.max(2, Math.ceil(height / 2)),
        flowTargets,
      );
    }
  }

  function clear() {
    for (const target of [...targets, ...flowTargets]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.clearColor(storage.neutral, storage.neutral, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function resetPointer() {
    pointer.inside = false;
    pointer.mx = pointer.my = pointer.radius = 0;
    pointer.targetX = pointer.x;
    pointer.targetY = pointer.y;
  }

  function stop() {
    cancelAnimationFrame(frame);
    frame = previousTime = accumulator = energy = scrollOffset = 0;
    resetPointer();
    scene.hide();
    sceneDirty = true;
    if (!disposed) clear();
  }

  function destroy() {
    if (disposed) return;
    stop();
    disposed = true;
    resizeObserver?.disconnect();
    visibilityObserver?.disconnect();
    contentObserver?.disconnect();
    removeListeners.forEach((remove) => remove());
    freeTargets();
    if (sceneTexture) gl.deleteTexture(sceneTexture);
    if (geometry) gl.deleteBuffer(geometry);
    programs.forEach((p) => gl.deleteProgram(p));
    shaders.forEach((shader) => gl.deleteShader(shader));
    canvas.hidden = true;
  }

  function resize() {
    if (disposed) return;
    stop();
    const rect = canvas.getBoundingClientRect();
    cssWidth = Math.max(1, rect.width);
    cssHeight = Math.max(1, rect.height);
    const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const ratio = Math.min(
      devicePixelRatio || 1,
      2,
      Math.min(2560, maxTexture) / cssWidth,
      Math.min(1536, maxTexture) / cssHeight,
    );
    const renderWidth = Math.max(1, Math.round(cssWidth * ratio));
    const renderHeight = Math.max(1, Math.round(cssHeight * ratio));
    const nextWidth = Math.max(2, Math.round(cssWidth / 4));
    const nextHeight = Math.max(2, Math.round(cssHeight / 4));
    if (width !== nextWidth || height !== nextHeight || !targets.length) {
      freeTargets();
      width = nextWidth;
      height = nextHeight;
      try {
        allocateTargets();
      } catch (error) {
        if (storage === byteStorage) throw error;
        freeTargets();
        storage = byteStorage;
        allocateTargets();
      }
    }
    if (canvas.width !== renderWidth) canvas.width = renderWidth;
    if (canvas.height !== renderHeight) canvas.height = renderHeight;
    uploadScene();
    clear();
  }

  function uploadScene() {
    const source = scene.capture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, sceneTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    sceneDirty = false;
  }

  function use(pass, target, w, h) {
    gl.useProgram(pass.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, w, h);
    gl.bindBuffer(gl.ARRAY_BUFFER, geometry);
    gl.enableVertexAttribArray(pass.position);
    gl.vertexAttribPointer(pass.position, 2, gl.FLOAT, false, 0, 0);
  }

  function sampler(pass, name, unit, value) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, value);
    gl.uniform1i(pass.uniforms[name], unit);
  }

  function hasSelection() {
    const selection = document.getSelection();
    return selection && !selection.isCollapsed;
  }

  function schedule() {
    if (!frame && !disposed && onScreen && !document.hidden)
      frame = requestAnimationFrame(render);
  }

  function invalidate() {
    sceneDirty = true;
    if (energy > 0) schedule();
  }

  function simulate(toX, toY) {
    const dx = (toX - pointer.x) * width;
    const dy = (toY - pointer.y) * height;
    const distance = Math.hypot(
      (dx * cssWidth) / width,
      (dy * cssHeight) / height,
    );
    const active = pointer.inside && distance > 0.001;
    const previousRadius = pointer.radius;
    // A 6 CSS-pixel floor spans 1.5 simulation pixels, so a gentle stroke can
    // reach neighbouring texels without increasing the fast-swipe radius.
    const maxRadius = Math.max(40, cssWidth / 20);
    pointer.radius = active
      ? (Math.max(minRadius, Math.min(1, distance / 100) * maxRadius) *
          height) /
        cssHeight
      : 0;
    // Impulse uses seconds and simulation pixels, independently of display Hz.
    pointer.mx = 0.8 * pointer.mx + 0.8 * stepSeconds * dx;
    pointer.my = 0.8 * pointer.my + 0.8 * stepSeconds * dy;
    if (active) {
      energy = 1;
    } else if (storage.minimumChange > 0) {
      energy = Math.max(
        0,
        energy -
          Math.max((1 - decay[1]) * energy, storage.minimumChange) +
          storage.rounding,
      );
    } else {
      // Half-float rounding scales with the remaining weight. Adding a fixed
      // error each step would leave this bound above zero indefinitely.
      energy =
        energy * decay[1] * (1 + storage.relativeRounding) +
        storage.absoluteRounding;
    }

    use(sim, targets[1].framebuffer, width, height);
    sampler(sim, "u_state", 0, targets[0].texture);
    sampler(sim, "u_flow", 1, flowTargets[1].texture);
    const u = sim.uniforms;
    gl.uniform2f(u.u_size, width, height);
    gl.uniform2f(u.u_from, pointer.x * width, pointer.y * height);
    gl.uniform2f(u.u_to, toX * width, toY * height);
    gl.uniform2f(u.u_impulse, pointer.mx, pointer.my);
    gl.uniform2f(u.u_radius, previousRadius, pointer.radius);
    gl.uniform2f(u.u_scroll, 0, scrollOffset);
    gl.uniform3fv(u.u_decay, decay);
    gl.uniform1f(u.u_active, active ? 1 : 0);
    gl.uniform1f(u.u_neutral, storage.neutral);
    gl.uniform1f(u.u_flowSpeed, flowSpeed);
    gl.uniform1f(u.u_minimumChange, storage.minimumChange);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    targets.reverse();
    scrollOffset = 0;
    pointer.x = toX;
    pointer.y = toY;

    for (let i = 0; i < 2; i++) {
      const output = flowTargets[i];
      use(soften, output.framebuffer, output.width, output.height);
      sampler(
        soften,
        "u_state",
        0,
        i ? flowTargets[0].texture : targets[0].texture,
      );
      gl.uniform2f(
        soften.uniforms.u_step,
        i ? 0 : 1 / output.width,
        i ? 1 / output.height : 0,
      );
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  function draw(time) {
    if (sceneDirty) uploadScene();
    const elapsed = previousTime
      ? Math.min(0.05, (time - previousTime) / 1000)
      : stepSeconds;
    previousTime = time;
    accumulator = Math.min(accumulator + elapsed, stepSeconds * 3);
    const steps = Math.floor((accumulator + 0.00000001) / stepSeconds);
    const fromX = pointer.x,
      fromY = pointer.y;
    for (let i = 1; i <= steps; i++) {
      const fraction = i / steps;
      simulate(
        fromX + (pointer.targetX - fromX) * fraction,
        fromY + (pointer.targetY - fromY) * fraction,
      );
    }
    accumulator = Math.max(0, accumulator - steps * stepSeconds);
    const pending =
      Math.hypot(
        (pointer.targetX - pointer.x) * cssWidth,
        (pointer.targetY - pointer.y) * cssHeight,
      ) > 0.001;
    if (energy <= visibilityRange[0] && !pending) {
      stop();
      return;
    }

    use(view, null, canvas.width, canvas.height);
    sampler(view, "u_state", 0, targets[0].texture);
    sampler(view, "u_scene", 2, sceneTexture);
    gl.uniform2f(view.uniforms.u_texel, 1 / width, 1 / height);
    gl.uniform2f(view.uniforms.u_cssSize, cssWidth, cssHeight);
    gl.uniform2fv(view.uniforms.u_visibility, visibilityRange);
    gl.uniform3fv(view.uniforms.u_background, scene.background);
    gl.uniform1f(view.uniforms.u_intensity, intensity);
    gl.uniform1f(view.uniforms.u_refraction, refraction);
    gl.uniform1f(view.uniforms.u_neutral, storage.neutral);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    scene.show();
    schedule();
  }

  function render(time) {
    frame = 0;
    if (disposed) return;
    if (!onScreen || document.hidden || hasSelection() || scene.blocked()) {
      stop();
      return;
    }
    try {
      draw(time);
    } catch {
      destroy();
    }
  }

  function onMove(event) {
    if (
      disposed ||
      !onScreen ||
      document.hidden ||
      event.pointerType === "touch" ||
      event.buttons ||
      hasSelection() ||
      scene.blocked()
    )
      return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (event.clientX - rect.left) / rect.width;
    const y = 1 - (event.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      resetPointer();
      return;
    }
    if (hoverTarget !== event.target) {
      hoverTarget = event.target;
      invalidate();
    }
    if (!pointer.inside) {
      pointer.x = pointer.targetX = x;
      pointer.y = pointer.targetY = y;
      pointer.inside = true;
      return;
    }
    pointer.targetX = x;
    pointer.targetY = y;
    schedule();
  }

  try {
    sim = program(simulation);
    soften = program(blur);
    view = program(display);
    geometry = gl.createBuffer();
    if (!geometry) throw new Error("Cannot create vapour geometry");
    gl.bindBuffer(gl.ARRAY_BUFFER, geometry);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    gl.disable(gl.BLEND);
    sceneTexture = texture();
    resize();
    const refresh = () => {
      try {
        resize();
      } catch {
        destroy();
      }
    };
    resizeObserver = new ResizeObserver(refresh);
    resizeObserver.observe(canvas);
    for (const element of scene.elements) resizeObserver.observe(element);
    visibilityObserver = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      if (!onScreen) stop();
    });
    visibilityObserver.observe(canvas);
    contentObserver = new MutationObserver(() => {
      if (scene.blocked()) stop();
      invalidate();
    });
    for (const element of scene.elements)
      contentObserver.observe(element, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "class",
          "style",
          "data-theme",
          "aria-current",
          "aria-pressed",
          "hidden",
        ],
      });
    listen(host, "pointermove", onMove, { passive: true });
    listen(host, "pointerleave", resetPointer);
    listen(host, "pointerdown", stop, { passive: true });
    listen(window, "keydown", stop);
    listen(
      window,
      "scroll",
      () => {
        scrollOffset += (window.scrollY - scrollY) / cssHeight;
        scrollY = window.scrollY;
        resetPointer();
        invalidate();
      },
      { passive: true },
    );
    listen(host, "scroll", invalidate, { capture: true, passive: true });
    listen(window, "resize", refresh, { passive: true });
    listen(document.fonts, "loadingdone", refresh);
    listen(document, "selectionchange", () => {
      if (hasSelection()) stop();
    });
    listen(document, "visibilitychange", () => {
      if (document.hidden) stop();
    });
    listen(canvas, "webglcontextlost", destroy);
  } catch (error) {
    destroy();
    throw error;
  }
  return { destroy };
}
