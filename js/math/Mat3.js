// 3x3 matrix, row-major storage in Float64Array. Used for inertia tensors.
export class Mat3 {
  constructor() {
    this.e = new Float64Array(9);
    this.e[0] = 1; this.e[4] = 1; this.e[8] = 1;
  }

  set(m00, m01, m02, m10, m11, m12, m20, m21, m22) {
    const e = this.e;
    e[0] = m00; e[1] = m01; e[2] = m02;
    e[3] = m10; e[4] = m11; e[5] = m12;
    e[6] = m20; e[7] = m21; e[8] = m22;
    return this;
  }

  copy(m) { this.e.set(m.e); return this; }

  static identity(out) {
    out.e.fill(0);
    out.e[0] = 1; out.e[4] = 1; out.e[8] = 1;
    return out;
  }

  static diagonal(x, y, z, out) {
    out.e.fill(0);
    out.e[0] = x; out.e[4] = y; out.e[8] = z;
    return out;
  }

  static mul(a, b, out) {
    const ae = a.e, be = b.e;
    const r0 = ae[0] * be[0] + ae[1] * be[3] + ae[2] * be[6];
    const r1 = ae[0] * be[1] + ae[1] * be[4] + ae[2] * be[7];
    const r2 = ae[0] * be[2] + ae[1] * be[5] + ae[2] * be[8];
    const r3 = ae[3] * be[0] + ae[4] * be[3] + ae[5] * be[6];
    const r4 = ae[3] * be[1] + ae[4] * be[4] + ae[5] * be[7];
    const r5 = ae[3] * be[2] + ae[4] * be[5] + ae[5] * be[8];
    const r6 = ae[6] * be[0] + ae[7] * be[3] + ae[8] * be[6];
    const r7 = ae[6] * be[1] + ae[7] * be[4] + ae[8] * be[7];
    const r8 = ae[6] * be[2] + ae[7] * be[5] + ae[8] * be[8];
    const oe = out.e;
    oe[0] = r0; oe[1] = r1; oe[2] = r2;
    oe[3] = r3; oe[4] = r4; oe[5] = r5;
    oe[6] = r6; oe[7] = r7; oe[8] = r8;
    return out;
  }

  // out = a * bᵀ
  static mulTranspose(a, b, out) {
    const ae = a.e, be = b.e;
    const r0 = ae[0] * be[0] + ae[1] * be[1] + ae[2] * be[2];
    const r1 = ae[0] * be[3] + ae[1] * be[4] + ae[2] * be[5];
    const r2 = ae[0] * be[6] + ae[1] * be[7] + ae[2] * be[8];
    const r3 = ae[3] * be[0] + ae[4] * be[1] + ae[5] * be[2];
    const r4 = ae[3] * be[3] + ae[4] * be[4] + ae[5] * be[5];
    const r5 = ae[3] * be[6] + ae[4] * be[7] + ae[5] * be[8];
    const r6 = ae[6] * be[0] + ae[7] * be[1] + ae[8] * be[2];
    const r7 = ae[6] * be[3] + ae[7] * be[4] + ae[8] * be[5];
    const r8 = ae[6] * be[6] + ae[7] * be[7] + ae[8] * be[8];
    const oe = out.e;
    oe[0] = r0; oe[1] = r1; oe[2] = r2;
    oe[3] = r3; oe[4] = r4; oe[5] = r5;
    oe[6] = r6; oe[7] = r7; oe[8] = r8;
    return out;
  }

  static mulVec(m, v, out) {
    const e = m.e;
    const x = e[0] * v.x + e[1] * v.y + e[2] * v.z;
    const y = e[3] * v.x + e[4] * v.y + e[5] * v.z;
    const z = e[6] * v.x + e[7] * v.y + e[8] * v.z;
    out.x = x; out.y = y; out.z = z;
    return out;
  }

  static invert(m, out) {
    const e = m.e;
    const a00 = e[0], a01 = e[1], a02 = e[2];
    const a10 = e[3], a11 = e[4], a12 = e[5];
    const a20 = e[6], a21 = e[7], a22 = e[8];
    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;
    let det = a00 * b01 + a01 * b11 + a02 * b21;
    if (Math.abs(det) < 1e-18) return Mat3.identity(out);
    det = 1.0 / det;
    const oe = out.e;
    const r0 = b01 * det;
    const r1 = (-a22 * a01 + a02 * a21) * det;
    const r2 = (a12 * a01 - a02 * a11) * det;
    const r3 = b11 * det;
    const r4 = (a22 * a00 - a02 * a20) * det;
    const r5 = (-a12 * a00 + a02 * a10) * det;
    const r6 = b21 * det;
    const r7 = (-a21 * a00 + a01 * a20) * det;
    const r8 = (a11 * a00 - a01 * a10) * det;
    oe[0] = r0; oe[1] = r1; oe[2] = r2;
    oe[3] = r3; oe[4] = r4; oe[5] = r5;
    oe[6] = r6; oe[7] = r7; oe[8] = r8;
    return out;
  }

  // out = R * I * Rᵀ — transform body-space tensor to world space
  static similarity(R, I, out, tmp) {
    Mat3.mul(R, I, tmp);
    return Mat3.mulTranspose(tmp, R, out);
  }
}
