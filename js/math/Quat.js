// Unit quaternion (w, x, y, z) for orientation. Static out-param API like Vec3.
export class Quat {
  constructor(w = 1, x = 0, y = 0, z = 0) {
    this.w = w; this.x = x; this.y = y; this.z = z;
  }

  set(w, x, y, z) { this.w = w; this.x = x; this.y = y; this.z = z; return this; }
  copy(q) { this.w = q.w; this.x = q.x; this.y = q.y; this.z = q.z; return this; }
  clone() { return new Quat(this.w, this.x, this.y, this.z); }

  static identity(out) { out.w = 1; out.x = 0; out.y = 0; out.z = 0; return out; }

  static mul(a, b, out) {
    const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
    const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
    const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
    const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
    out.w = w; out.x = x; out.y = y; out.z = z;
    return out;
  }

  static conjugate(q, out) {
    out.w = q.w; out.x = -q.x; out.y = -q.y; out.z = -q.z;
    return out;
  }

  static normalize(q, out) {
    const l = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
    if (l < 1e-12) return Quat.identity(out);
    const inv = 1 / l;
    out.w = q.w * inv; out.x = q.x * inv; out.y = q.y * inv; out.z = q.z * inv;
    return out;
  }

  // Rotate vector v by quaternion q: q v q*  (optimized form, no temp quats)
  static rotateVec(q, v, out) {
    const qw = q.w, qx = q.x, qy = q.y, qz = q.z;
    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (qy * v.z - qz * v.y);
    const ty = 2 * (qz * v.x - qx * v.z);
    const tz = 2 * (qx * v.y - qy * v.x);
    // out = v + qw * t + cross(q.xyz, t)
    out.x = v.x + qw * tx + (qy * tz - qz * ty);
    out.y = v.y + qw * ty + (qz * tx - qx * tz);
    out.z = v.z + qw * tz + (qx * ty - qy * tx);
    return out;
  }

  // Rotate by inverse (conjugate) of q — world → body frame
  static rotateVecInv(q, v, out) {
    const qw = q.w, qx = -q.x, qy = -q.y, qz = -q.z;
    const tx = 2 * (qy * v.z - qz * v.y);
    const ty = 2 * (qz * v.x - qx * v.z);
    const tz = 2 * (qx * v.y - qy * v.x);
    out.x = v.x + qw * tx + (qy * tz - qz * ty);
    out.y = v.y + qw * ty + (qz * tx - qx * tz);
    out.z = v.z + qw * tz + (qx * ty - qy * tx);
    return out;
  }

  static fromAxisAngle(axis, angle, out) {
    const half = angle * 0.5;
    const s = Math.sin(half);
    out.w = Math.cos(half);
    out.x = axis.x * s; out.y = axis.y * s; out.z = axis.z * s;
    return out;
  }

  // q̇ = 0.5 * [0, ω] * q  — derivative for angular velocity ω (world frame)
  static derivative(q, omega, out) {
    const ox = omega.x, oy = omega.y, oz = omega.z;
    out.w = 0.5 * (-ox * q.x - oy * q.y - oz * q.z);
    out.x = 0.5 * ( ox * q.w + oy * q.z - oz * q.y);
    out.y = 0.5 * (-ox * q.z + oy * q.w + oz * q.x);
    out.z = 0.5 * ( ox * q.y - oy * q.x + oz * q.w);
    return out;
  }

  // Fill a Mat3 (row-major Float64Array[9]) from quaternion
  static toMat3(q, m) {
    const w = q.w, x = q.x, y = q.y, z = q.z;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    m.e[0] = 1 - (yy + zz); m.e[1] = xy - wz;       m.e[2] = xz + wy;
    m.e[3] = xy + wz;       m.e[4] = 1 - (xx + zz); m.e[5] = yz - wx;
    m.e[6] = xz - wy;       m.e[7] = yz + wx;       m.e[8] = 1 - (xx + yy);
    return m;
  }

  static slerp(a, b, t, out) {
    let cosom = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
    let bw = b.w, bx = b.x, by = b.y, bz = b.z;
    if (cosom < 0) { cosom = -cosom; bw = -bw; bx = -bx; by = -by; bz = -bz; }
    let s0, s1;
    if (1 - cosom > 1e-6) {
      const omega = Math.acos(cosom);
      const sinom = Math.sin(omega);
      s0 = Math.sin((1 - t) * omega) / sinom;
      s1 = Math.sin(t * omega) / sinom;
    } else {
      s0 = 1 - t; s1 = t;
    }
    out.w = s0 * a.w + s1 * bw;
    out.x = s0 * a.x + s1 * bx;
    out.y = s0 * a.y + s1 * by;
    out.z = s0 * a.z + s1 * bz;
    return out;
  }
}
