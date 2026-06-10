import { clamp, lerp } from '../math/MathUtils.js';

// Aerodynamic coefficient model. Inside the table range (attached flow) we
// interpolate measured Cl/Cd data; beyond stall we blend smoothly into the
// flat-plate model which is valid for fully separated flow at any angle:
//   Cl = 2 sin α cos α,  Cd = 2 sin² α
// This gives physically sane behavior over the full ±180° range — essential
// for flapping wings whose strips routinely see extreme local angles.
const registry = new Map();

export class AirfoilData {
  constructor(id, table) {
    this.id = id;
    // table: { alpha: [deg...], cl: [...], cd: [...], cm?: [...] }
    this.alpha = table.alpha.map(a => a * Math.PI / 180);
    this.cl = table.cl;
    this.cd = table.cd;
    this.alphaMin = this.alpha[0];
    this.alphaMax = this.alpha[this.alpha.length - 1];
    registry.set(id, this);
  }

  _interp(arr, alpha) {
    const A = this.alpha;
    let lo = 0, hi = A.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (A[mid] <= alpha) lo = mid; else hi = mid;
    }
    const t = (alpha - A[lo]) / (A[hi] - A[lo]);
    return lerp(arr[lo], arr[hi], t);
  }

  Cl(alpha) {
    if (alpha >= this.alphaMin && alpha <= this.alphaMax) {
      return this._interp(this.cl, alpha);
    }
    // Post-stall: blend table edge into flat plate over 10°
    const flat = AirfoilData.flatPlateCl(alpha);
    const edge = alpha > this.alphaMax ? this.alphaMax : this.alphaMin;
    const excess = Math.abs(alpha - edge);
    const blend = clamp(excess / (10 * Math.PI / 180), 0, 1);
    return lerp(this._interp(this.cl, edge), flat, blend);
  }

  Cd(alpha) {
    if (alpha >= this.alphaMin && alpha <= this.alphaMax) {
      return this._interp(this.cd, alpha);
    }
    const flat = AirfoilData.flatPlateCd(alpha);
    const edge = alpha > this.alphaMax ? this.alphaMax : this.alphaMin;
    const excess = Math.abs(alpha - edge);
    const blend = clamp(excess / (10 * Math.PI / 180), 0, 1);
    return lerp(this._interp(this.cd, edge), flat, blend);
  }

  static flatPlateCl(alpha) { return 2 * Math.sin(alpha) * Math.cos(alpha); }
  static flatPlateCd(alpha) { return 0.02 + 2 * Math.sin(alpha) * Math.sin(alpha); }

  static get(id) {
    const a = registry.get(id);
    if (!a) throw new Error(`Airfoil '${id}' not loaded`);
    return a;
  }

  static has(id) { return registry.has(id); }

  static async preload(entries) {
    // entries: [{ id, url }]
    await Promise.all(entries.map(async ({ id, url }) => {
      const res = await fetch(url);
      const table = await res.json();
      new AirfoilData(id, table);
    }));
  }

  static registerAnalytic(id, clFn, cdFn) {
    // Build a dense table from analytic functions (used for blunt bodies)
    const alpha = [], cl = [], cd = [];
    for (let deg = -180; deg <= 180; deg += 5) {
      const a = deg * Math.PI / 180;
      alpha.push(deg);
      cl.push(clFn(a));
      cd.push(cdFn(a));
    }
    return new AirfoilData(id, { alpha, cl, cd });
  }
}
