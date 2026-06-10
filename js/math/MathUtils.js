export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const TWO_PI = Math.PI * 2;

export function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function wrapAngle(a) {
  // Wrap to [-π, π]
  a = a % TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  else if (a < -Math.PI) a += TWO_PI;
  return a;
}

export function remap(v, inLo, inHi, outLo, outHi) {
  return outLo + (outHi - outLo) * clamp((v - inLo) / (inHi - inLo), 0, 1);
}
