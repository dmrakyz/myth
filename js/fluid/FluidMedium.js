import { Vec3 } from '../math/Vec3.js';
import { clamp } from '../math/MathUtils.js';

// Queries the fluid state at any world point: density, and flow velocity.
// Above the water surface → air (ISA density falloff with altitude, wind +
// turbulence). Below → water (current). Blended across a ±0.1 m band at the
// surface so forces don't step discontinuously.
const AIR_RHO0 = 1.225;
const WATER_RHO = 1000;
const BLEND = 0.1;

export class FluidMedium {
  constructor(waterSurface) {
    this.water = waterSurface;
    this.windSpeed = 0;
    this.windDir = new Vec3(1, 0, 0);
    this.currentSpeed = 0;
    this.currentDir = new Vec3(1, 0, 0);
    this.time = 0;
    this._gust = new Vec3();
  }

  update(dt) { this.time += dt; }

  airDensity(altitude) {
    const h = Math.max(0, altitude);
    const base = 1 - 2.2558e-5 * h;
    return AIR_RHO0 * Math.pow(base > 0 ? base : 0, 4.2561);
  }

  // Submersion fraction at a point: 0 = fully in air, 1 = fully in water
  submersion(pos) {
    const wh = this.water.height(pos.x, pos.z);
    return clamp((wh + BLEND - pos.y) / (2 * BLEND), 0, 1);
  }

  density(pos) {
    const s = this.submersion(pos);
    if (s <= 0) return this.airDensity(pos.y);
    if (s >= 1) return WATER_RHO;
    return this.airDensity(pos.y) * (1 - s) + WATER_RHO * s;
  }

  // Layered sinusoid pseudo-turbulence — cheap, deterministic, divergence-ish
  _turbulence(pos, out) {
    const t = this.time;
    const a = this.windSpeed * 0.12;
    if (a < 1e-4) { Vec3.zero(out); return out; }
    out.x = a * (Math.sin(0.31 * pos.x + 1.7 * t) + 0.5 * Math.sin(1.13 * pos.z + 2.9 * t));
    out.y = a * 0.6 * (Math.sin(0.43 * pos.y + 2.1 * t + 1.3) + 0.5 * Math.sin(0.91 * pos.x + 1.7 * t));
    out.z = a * (Math.sin(0.27 * pos.z + 1.5 * t + 2.6) + 0.5 * Math.sin(1.31 * pos.y + 2.3 * t));
    return out;
  }

  // Fluid velocity at a point (wind in air, current in water, blended)
  flow(pos, out) {
    const s = this.submersion(pos);
    if (s >= 1) {
      Vec3.scale(this.currentDir, this.currentSpeed, out);
      return out;
    }
    Vec3.scale(this.windDir, this.windSpeed, out);
    this._turbulence(pos, this._gust);
    Vec3.add(out, this._gust, out);
    if (s > 0) {
      out.x = out.x * (1 - s) + this.currentDir.x * this.currentSpeed * s;
      out.y = out.y * (1 - s);
      out.z = out.z * (1 - s) + this.currentDir.z * this.currentSpeed * s;
    }
    return out;
  }
}

export { AIR_RHO0, WATER_RHO };
