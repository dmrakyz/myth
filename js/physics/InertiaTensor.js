import { Mat3 } from '../math/Mat3.js';

// Analytic body-frame inertia tensors for primitive shapes.
// Dimensions convention:
//   ellipsoid: [a, b, c] semi-axes (x, y, z)
//   capsule:   [radius, halfLength] along z
//   box:       [hx, hy, hz] half-extents
//   plate:     [chord (x), span (z)] thin flat plate in xz plane

export function ellipsoidInertia(mass, a, b, c, out) {
  const k = mass / 5;
  return Mat3.diagonal(k * (b * b + c * c), k * (a * a + c * c), k * (a * a + b * b), out);
}

export function boxInertia(mass, hx, hy, hz, out) {
  const k = mass / 3;
  return Mat3.diagonal(k * (hy * hy + hz * hz), k * (hx * hx + hz * hz), k * (hx * hx + hy * hy), out);
}

export function capsuleInertia(mass, radius, halfLength, out) {
  // Cylinder along z + two hemispherical caps
  const r2 = radius * radius;
  const L = halfLength * 2;
  const volCyl = Math.PI * r2 * L;
  const volSph = (4 / 3) * Math.PI * r2 * radius;
  const total = volCyl + volSph;
  const mCyl = mass * (volCyl / total);
  const mSph = mass * (volSph / total);

  const Izz = mCyl * r2 / 2 + mSph * 2 * r2 / 5;
  const Ixx = mCyl * (r2 / 4 + L * L / 12)
    + mSph * (2 * r2 / 5 + halfLength * halfLength + (3 / 8) * radius * halfLength);
  return Mat3.diagonal(Ixx, Ixx, Izz, out);
}

export function plateInertia(mass, chord, span, out) {
  // Thin rectangular plate in xz plane (negligible thickness in y)
  const k = mass / 12;
  return Mat3.diagonal(k * span * span, k * (chord * chord + span * span), k * chord * chord, out);
}

export function inertiaForShape(shape, dimensions, mass, out) {
  const d = dimensions;
  switch (shape) {
    case 'ellipsoid': return ellipsoidInertia(mass, d[0], d[1], d[2], out);
    case 'capsule':   return capsuleInertia(mass, d[0], d[1], out);
    case 'box':       return boxInertia(mass, d[0], d[1], d[2], out);
    case 'plate':     return plateInertia(mass, d[0], d[1], out);
    default:          return ellipsoidInertia(mass, d[0] ?? 0.1, d[1] ?? 0.1, d[2] ?? 0.1, out);
  }
}

export function volumeForShape(shape, d) {
  switch (shape) {
    case 'ellipsoid': return (4 / 3) * Math.PI * d[0] * d[1] * d[2];
    case 'capsule':   return Math.PI * d[0] * d[0] * (2 * d[1]) + (4 / 3) * Math.PI * d[0] ** 3;
    case 'box':       return 8 * d[0] * d[1] * d[2];
    case 'plate':     return d[0] * d[1] * 0.002; // 2mm effective thickness
    default:          return 0.001;
  }
}

// Characteristic radius for buoyancy submersion blending
export function boundingRadiusForShape(shape, d) {
  switch (shape) {
    case 'ellipsoid': return Math.max(d[0], d[1], d[2]);
    case 'capsule':   return d[0] + d[1];
    case 'box':       return Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
    case 'plate':     return Math.max(d[0], d[1]) * 0.5;
    default:          return 0.1;
  }
}
