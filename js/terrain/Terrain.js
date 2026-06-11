import { Vec3 } from '../math/Vec3.js';

// Procedural island terrain: deterministic value-noise fBm heightfield.
// Anything below seaLevel is ocean floor; land rises above it as islands
// and mountains. The same height() drives physics ground contact and the
// renderer's displaced mesh, so visuals and collisions always agree.
//
// A guaranteed island is blended in ahead of the spawn point (−z) so a
// player flying straight reaches land in ~30 s without hunting for it.

function hash2(ix, iz) {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t) { return t * t * (3 - 2 * t); }

// 2D value noise in [0,1]
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  const ux = smooth(fx), uz = smooth(fz);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

export class Terrain {
  constructor({ seaLevel = -10 } = {}) {
    this.seaLevel = seaLevel;
    // fBm params: low frequency rolling islands + finer ridge detail
    this.baseFreq = 1 / 220;
    this.amp = 55;
    // Most of the map is ocean: noise is recentered so ~60% sits below sea
    this.bias = -0.34;
  }

  // Terrain surface height (world y) at horizontal position (x, z).
  height(x, z) {
    const f = this.baseFreq;
    let n = 0, a = 1, fr = 1, norm = 0;
    for (let o = 0; o < 5; o++) {
      n += a * vnoise(x * f * fr + o * 13.7, z * f * fr + o * 7.3);
      norm += a;
      a *= 0.5; fr *= 2.1;
    }
    n = n / norm + this.bias;                 // roughly [-0.34, 0.66]
    // Sharpen peaks: positive part squared keeps shores gentle, peaks steep
    let h = this.seaLevel + (n > 0 ? n * n * 2.6 : n * 0.6) * this.amp;

    // Guaranteed island ahead of spawn (spawn looks down −z)
    const dx = x - 40, dz = z + 320;
    const d2 = dx * dx + dz * dz;
    const island = 34 * Math.exp(-d2 / (2 * 130 * 130));
    h = Math.max(h, this.seaLevel - 6 + island);

    return h;
  }

  // Height above terrain (negative = below ground)
  agl(pos) { return pos.y - this.height(pos.x, pos.z); }

  isLand(x, z) { return this.height(x, z) > this.seaLevel + 0.05; }

  // Finite-difference surface normal
  normal(x, z, out = new Vec3()) {
    const e = 0.6;
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    out.set(-hx / (2 * e), 1, -hz / (2 * e));
    Vec3.norm(out, out);
    return out;
  }
}
