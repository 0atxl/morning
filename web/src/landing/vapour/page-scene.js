// A renderer for this landing page's hero text. It uses the
// live layout/styles; no screenshots, remote assets or page-capture library.
export function createPageScene(host, canvas) {
  const source = document.createElement("canvas");
  const context = source.getContext("2d");
  if (!context || !("letterSpacing" in context))
    throw new Error("Canvas text spacing unavailable");
  const elements = [
    ...host.querySelectorAll("[data-vapour-text], [data-vapour-scene]"),
  ];
  const demo = host.querySelector("[data-vapour-scene]");
  const baselines = new Map(),
    icons = new Map();
  const background = [250 / 255, 250 / 255, 250 / 255];
  let origin,
    scale = 1;

  function baselineOffset(style) {
    const key = `${style.fontFamily}/${style.fontSize}/${style.fontWeight}/${style.fontStyle}/${style.lineHeight}`;
    if (baselines.has(key)) return baselines.get(key);
    const probe = document.createElement("span");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;white-space:pre;";
    for (const property of [
      "fontFamily",
      "fontSize",
      "fontStyle",
      "fontWeight",
      "fontKerning",
      "letterSpacing",
      "lineHeight",
    ])
      probe.style[property] = style[property];
    const text = document.createTextNode("Mg");
    const marker = document.createElement("span");
    marker.style.cssText =
      "display:inline-block;width:0;height:0;padding:0;vertical-align:baseline;";
    probe.append(text, marker);
    document.body.append(probe);
    try {
      const range = document.createRange();
      range.selectNodeContents(text);
      const baseline =
        marker.getBoundingClientRect().top - range.getBoundingClientRect().top;
      baselines.set(key, baseline);
      return baseline;
    } finally {
      probe.remove();
    }
  }

  function text(node, style) {
    if (!node.textContent.trim()) return;
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    context.fontKerning = style.fontKerning;
    context.letterSpacing =
      style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
    context.textBaseline = "alphabetic";
    context.textAlign = "left";
    context.direction = "ltr";
    context.fillStyle = style.color;
    const baseline = baselineOffset(style);
    const range = document.createRange();
    if (style.textOverflow === "ellipsis" && style.whiteSpace === "nowrap") {
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      const box = node.parentElement.getBoundingClientRect();
      const available = Math.max(
        0,
        box.right - rect.left - (parseFloat(style.paddingRight) || 0),
      );
      let value = node.textContent.trim().replace(/\s+/g, " ");
      if (context.measureText(value).width > available) {
        while (value && context.measureText(value + "…").width > available)
          value = value.slice(0, -1);
        value += "…";
      }
      context.fillText(
        value,
        rect.left - origin.left,
        rect.top - origin.top + baseline,
      );
      return;
    }
    for (const match of node.textContent.matchAll(/\S+/g)) {
      const start = match.index,
        end = start + match[0].length;
      range.setStart(node, start);
      range.setEnd(node, end);
      const rects = range.getClientRects();
      if (!rects.length) continue;
      if (rects.length === 1) {
        const rect = rects[0];
        context.fillText(
          match[0],
          rect.left - origin.left,
          rect.top - origin.top + baseline,
        );
        continue;
      }
      // Grid filenames can wrap inside a word. Group characters by the DOM's
      // line positions, then draw each line with its native kerning intact.
      let line = "",
        lineRect;
      const flush = () => {
        if (line)
          context.fillText(
            line,
            lineRect.left - origin.left,
            lineRect.top - origin.top + baseline,
          );
      };
      for (let i = start; i < end; i++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        if (lineRect && Math.abs(rect.top - lineRect.top) > 1) {
          flush();
          line = "";
        }
        if (!line) lineRect = rect;
        line += node.textContent[i];
      }
      flush();
    }
  }

  function roundedBox(x, y, w, h, radius) {
    context.beginPath();
    context.roundRect(
      x,
      y,
      Math.max(0, w),
      Math.max(0, h),
      Math.max(0, Math.min(radius, w / 2, h / 2)),
    );
  }

  function boxRadius(style, box) {
    const value = style.borderTopLeftRadius;
    return value.endsWith("%")
      ? (parseFloat(value) * Math.min(box.width, box.height)) / 100
      : parseFloat(value) || 0;
  }

  function shadows(style, box, radius) {
    if (style.boxShadow === "none") return;
    const parts = style.boxShadow.split(/,(?![^()]*\))/).reverse();
    for (const part of parts) {
      if (part.includes("inset")) continue;
      const colour = part.match(/rgba?\([^)]*\)|#[\da-f]+/i)?.[0];
      if (!colour) continue;
      const dimensions = part
        .replace(colour, "")
        .match(/-?[\d.]+px/g)
        ?.map(parseFloat);
      if (!dimensions || dimensions.length < 3) continue;
      const [dx, dy, blur, spread = 0] = dimensions;
      context.save();
      context.shadowColor = colour;
      context.shadowOffsetX = dx * scale;
      context.shadowOffsetY = dy * scale;
      context.shadowBlur = blur * scale;
      context.fillStyle = style.backgroundColor;
      roundedBox(
        box.left - origin.left - spread,
        box.top - origin.top - spread,
        box.width + spread * 2,
        box.height + spread * 2,
        radius + spread,
      );
      context.fill();
      context.restore();
    }
  }

  function boxBackground(style, box, radius) {
    const x = box.left - origin.left,
      y = box.top - origin.top;
    roundedBox(x, y, box.width, box.height, radius);
    context.fillStyle = style.backgroundColor;
    context.fill();
    const sides = ["Top", "Right", "Bottom", "Left"];
    const widths = sides.map(
      (side) => parseFloat(style[`border${side}Width`]) || 0,
    );
    if (
      widths.every((value) => value === widths[0]) &&
      widths[0] &&
      sides.every(
        (side) => style[`border${side}Color`] === style.borderTopColor,
      )
    ) {
      const width = widths[0];
      roundedBox(
        x + width / 2,
        y + width / 2,
        box.width - width,
        box.height - width,
        Math.max(0, radius - width / 2),
      );
      context.strokeStyle = style.borderTopColor;
      context.lineWidth = width;
      context.stroke();
    } else {
      const positions = [
        [x, y, box.width, widths[0]],
        [x + box.width - widths[1], y, widths[1], box.height],
        [x, y + box.height - widths[2], box.width, widths[2]],
        [x, y, widths[3], box.height],
      ];
      sides.forEach((side, i) => {
        if (!widths[i]) return;
        context.fillStyle = style[`border${side}Color`];
        context.fillRect(...positions[i]);
      });
    }
  }

  function svg(element, style, box) {
    const href = element.querySelector("use")?.getAttribute("href");
    if (!href?.startsWith("#")) return;
    if (!icons.has(href)) {
      const symbol = document.getElementById(href.slice(1));
      if (!symbol) return;
      const viewBox = symbol.getAttribute("viewBox").split(/\s+/).map(Number);
      const shapes = [...symbol.children].map((shape) => {
        const path = new Path2D();
        const value = (name) => Number(shape.getAttribute(name) || 0);
        if (shape.tagName === "path")
          path.addPath(new Path2D(shape.getAttribute("d")));
        else if (shape.tagName === "circle")
          path.arc(value("cx"), value("cy"), value("r"), 0, Math.PI * 2);
        else if (shape.tagName === "rect")
          path.roundRect(
            value("x"),
            value("y"),
            value("width"),
            value("height"),
            value("rx"),
          );
        return {
          path,
          fill: shape.getAttribute("fill"),
          stroke: shape.getAttribute("stroke"),
        };
      });
      icons.set(href, { viewBox, shapes });
    }
    const {
      viewBox: [left, top, width, height],
      shapes,
    } = icons.get(href);
    const ratio = Math.min(box.width / width, box.height / height);
    context.save();
    context.translate(
      box.left - origin.left + (box.width - width * ratio) / 2,
      box.top - origin.top + (box.height - height * ratio) / 2,
    );
    context.scale(ratio, ratio);
    context.translate(-left, -top);
    context.lineWidth = parseFloat(style.strokeWidth) || 1;
    context.lineCap = style.strokeLinecap;
    context.lineJoin = style.strokeLinejoin;
    const colour = (value) => (value === "currentColor" ? style.color : value);
    for (const shape of shapes) {
      const fill = shape.fill || style.fill,
        stroke = shape.stroke || style.stroke;
      if (fill !== "none") {
        context.fillStyle = colour(fill);
        context.fill(shape.path);
      }
      if (stroke !== "none") {
        context.strokeStyle = colour(stroke);
        context.stroke(shape.path);
      }
    }
    context.restore();
  }

  function paint(element, root = false) {
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      element.classList.contains("sr-only")
    )
      return;
    const box = element.getBoundingClientRect();
    if (
      !box.width ||
      !box.height ||
      box.bottom < origin.top ||
      box.top > origin.bottom
    )
      return;
    context.save();
    if (!root) context.globalAlpha *= Number(style.opacity);
    if (element instanceof SVGElement) {
      svg(element, style, box);
      context.restore();
      return;
    }
    const radius = boxRadius(style, box);
    shadows(style, box, radius);
    boxBackground(style, box, radius);
    if (
      [style.overflowX, style.overflowY].some((value) =>
        /hidden|auto|scroll|clip/.test(value),
      )
    ) {
      roundedBox(
        box.left - origin.left + element.clientLeft,
        box.top - origin.top + element.clientTop,
        element.clientWidth,
        element.clientHeight,
        Math.max(0, radius - element.clientLeft),
      );
      context.clip();
    }
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text(child, style);
      else if (child.nodeType === Node.ELEMENT_NODE) paint(child);
    }
    context.restore();
  }

  function capture() {
    origin = canvas.getBoundingClientRect();
    if (!origin.width || !origin.height) throw new Error("Empty vapour scene");
    if (source.width !== canvas.width) source.width = canvas.width;
    if (source.height !== canvas.height) source.height = canvas.height;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, source.width, source.height);
    scale = source.width / origin.width;
    context.setTransform(scale, 0, 0, source.height / origin.height, 0, 0);
    const rgb = getComputedStyle(
      document.documentElement,
    ).backgroundColor.match(/[\d.]+/g);
    if (rgb?.length >= 3)
      for (let i = 0; i < 3; i++) background[i] = Number(rgb[i]) / 255;
    // Keep observing the preview for layout and interaction changes, but
    // never copy its rows or icons into the refracted scene.
    for (const element of elements) if (element !== demo) paint(element, true);
    return source;
  }

  function blocked() {
    if (demo?.querySelector(".demo-overlay:not([hidden])")) return true;
    const active = document.activeElement;
    return Boolean(demo?.contains(active) && active.matches(":focus-visible"));
  }

  return {
    elements,
    background,
    capture,
    blocked,
    show: () => host.classList.add("vapour-active"),
    hide: () => host.classList.remove("vapour-active"),
  };
}
