// Independent implementation of the flow model described in the supplied
// reverse-engineering notes. Noise gradients are evaluated analytically.
export const vertex = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * .5 + .5;
  gl_Position = vec4(a_position, 0., 1.);
}
`;

export const simulation = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_state, u_flow;
uniform vec2 u_size, u_from, u_to, u_impulse, u_radius, u_scroll;
uniform vec3 u_decay;
uniform float u_active, u_neutral, u_flowSpeed, u_minimumChange;

vec2 latticeGradient(vec2 cell) {
  float angle = 6.2831853 * fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
  return vec2(cos(angle), sin(angle));
}
vec3 gradientNoise(vec2 point) {
  vec2 cell = floor(point);
  vec2 f = fract(point);
  vec2 a = latticeGradient(cell);
  vec2 b = latticeGradient(cell + vec2(1., 0.));
  vec2 c = latticeGradient(cell + vec2(0., 1.));
  vec2 d = latticeGradient(cell + vec2(1., 1.));
  float va = dot(a, f);
  float vb = dot(b, f - vec2(1., 0.));
  float vc = dot(c, f - vec2(0., 1.));
  float vd = dot(d, f - vec2(1., 1.));
  vec2 blend = f * f * f * (f * (f * 6. - 15.) + 10.);
  vec2 derivative = 30. * f * f * (f * (f - 2.) + 1.);
  float value = mix(mix(va, vb, blend.x), mix(vc, vd, blend.x), blend.y);
  vec2 gradient = mix(mix(a, b, blend.x), mix(c, d, blend.x), blend.y);
  gradient += derivative * vec2(
    mix(vb - va, vd - vc, blend.y),
    mix(vc - va, vd - vb, blend.x)
  );
  return vec3(value, gradient);
}
vec4 readState(sampler2D map, vec2 uv) {
  if (uv.x < 0. || uv.x > 1. || uv.y < 0. || uv.y > 1.)
    return vec4(u_neutral, u_neutral, 0., 0.);
  return texture2D(map, uv);
}
void main() {
  vec2 position = v_uv * u_size;
  vec2 segment = u_to - u_from;
  float along = clamp(dot(position - u_from, segment) / max(dot(segment, segment), .000001), 0., 1.);
  float radius = mix(u_radius.x, u_radius.y, along);
  float distance = length(position - u_from - segment * along);
  float brush = (1. - smoothstep(-.01, max(radius, .001), distance)) * u_active;

  vec4 coarse = readState(u_flow, v_uv - u_scroll);
  // Noise uses a neutral value of .5 regardless of the fallback's encoding.
  vec2 motion = coarse.rg - u_neutral;
  vec2 encoded = motion + .5;
  vec3 first = gradientNoise(.02 * position * (1. - encoded));
  vec2 warped = .02 * position * (2. - encoded * (.5 + first.x) + .1 * first.yz);
  vec2 gradient = gradientNoise(warped).yz;
  vec2 backtrace = -25. * motion + 3. * (coarse.b + coarse.a) * gradient;
  // Slow the wake's transport without weakening the cursor impulse or
  // changing the refraction gain. Scrolling still follows the page directly.
  vec4 previous = readState(u_state, v_uv - u_scroll + backtrace * u_flowSpeed / u_size);

  vec2 velocity = (previous.rg - u_neutral) * u_decay.x + u_impulse * brush;
  vec2 change = (u_decay.yz - 1.) * previous.ba + brush;
  // Byte storage needs a minimum change to cross its quantization steps.
  // Float storage keeps continuous exponential decay all the way into the tail.
  if (u_minimumChange > 0.)
    change = sign(change) * max(abs(change), vec2(u_minimumChange));
  vec2 weights = clamp(previous.ba + change, 0., 1.);
  gl_FragColor = vec4(clamp(velocity + u_neutral, 0., 1.), weights);
}
`;

export const blur = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_state;
uniform vec2 u_step;
void main() {
  vec4 value = texture2D(u_state, v_uv) * .227027;
  value += texture2D(u_state, v_uv + u_step * 1.384615) * .316216;
  value += texture2D(u_state, v_uv - u_step * 1.384615) * .316216;
  value += texture2D(u_state, v_uv + u_step * 3.230769) * .0702705;
  value += texture2D(u_state, v_uv - u_step * 3.230769) * .0702705;
  gl_FragColor = value;
}
`;

export const display = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_state, u_scene;
uniform vec2 u_texel, u_cssSize, u_visibility;
uniform vec3 u_background;
uniform float u_intensity, u_refraction, u_neutral;
void main() {
  vec4 state = texture2D(u_state, v_uv);
  float weight = (state.b + state.a) * .5;
  if (weight <= u_visibility.x) {
    gl_FragColor = texture2D(u_scene, v_uv);
    return;
  }
  float visibility = smoothstep(u_visibility.x, u_visibility.y, weight);
  vec2 flow = 2. * (u_neutral - state.rg - .001) * weight;
  vec2 edge = min(v_uv, 1. - v_uv) * u_cssSize;
  float feather = smoothstep(0., 8., min(edge.x, edge.y));
  // Reference amount=3, multiplier=5. Nine forward samples produce both
  // refraction and the directional smear, without a separate lens/outline.
  vec2 stepUV = flow * 3.75 * u_texel * u_refraction * feather * visibility;
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  vec2 uv = v_uv + vec2(jitter, fract(jitter * 17.7)) * stepUV;
  vec4 scene = vec4(0.);
  for (int i = 0; i < 9; i++) {
    scene += texture2D(u_scene, uv);
    uv += stepUV;
  }
  scene /= 9.;

  // The phase and strength both come from velocity. High-weight interiors
  // become clear naturally; no density contour is drawn.
  // A broader visibility window reveals more of the moving folds. Half gain
  // balances the extra coverage and leaves dense interiors transparent.
  float transition = .5 * (1. - smoothstep(-.6, .6, weight));
  float strength = max(abs(flow.x), abs(flow.y));
  vec3 shift = sin(vec3(40. * (flow.x + flow.y)) + vec3(0., 1., 2.))
    * transition * 12.5 * strength * u_intensity * feather * visibility;
  vec3 background = u_background * (1. - scene.a);
  vec3 colour = clamp(scene.rgb + background + shift, 0., 1.);

  // Captured text/demo pixels receive the signed additive colour directly.
  // Over uncaptured HTML, use a bounded transparent film. This avoids placing
  // an opaque page-sized background in front of the real controls.
  float filmAlpha = min(.45, max(max(abs(shift.r), abs(shift.g)), abs(shift.b)) * 2.);
  float alpha = scene.a + (1. - scene.a) * filmAlpha;
  vec3 premultiplied = clamp(colour - u_background * (1. - alpha), vec3(0.), vec3(alpha));
  gl_FragColor = vec4(premultiplied, alpha);
}
`;
