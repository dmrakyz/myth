// Zero-allocation 3D vector. All static ops write into `out` and return it,
// so hot paths can reuse pooled instances instead of allocating.
export class Vec3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x; this.y = y; this.z = z;
  }

  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec3(this.x, this.y, this.z); }

  static add(a, b, out) {
    out.x = a.x + b.x; out.y = a.y + b.y; out.z = a.z + b.z;
    return out;
  }

  static sub(a, b, out) {
    out.x = a.x - b.x; out.y = a.y - b.y; out.z = a.z - b.z;
    return out;
  }

  static scale(a, s, out) {
    out.x = a.x * s; out.y = a.y * s; out.z = a.z * s;
    return out;
  }

  static addScaled(a, b, s, out) {
    out.x = a.x + b.x * s; out.y = a.y + b.y * s; out.z = a.z + b.z * s;
    return out;
  }

  static cross(a, b, out) {
    const x = a.y * b.z - a.z * b.y;
    const y = a.z * b.x - a.x * b.z;
    const z = a.x * b.y - a.y * b.x;
    out.x = x; out.y = y; out.z = z;
    return out;
  }

  static dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

  static len(a) { return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z); }
  static lenSq(a) { return a.x * a.x + a.y * a.y + a.z * a.z; }

  static norm(a, out) {
    const l = Vec3.len(a);
    if (l < 1e-12) { out.x = 0; out.y = 0; out.z = 0; return out; }
    const inv = 1 / l;
    out.x = a.x * inv; out.y = a.y * inv; out.z = a.z * inv;
    return out;
  }

  static negate(a, out) {
    out.x = -a.x; out.y = -a.y; out.z = -a.z;
    return out;
  }

  static lerp(a, b, t, out) {
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
    return out;
  }

  static dist(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  static zero(out) { out.x = 0; out.y = 0; out.z = 0; return out; }
}
