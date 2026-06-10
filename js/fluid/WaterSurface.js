// Gerstner wave water surface. The same wave parameters drive both physics
// (buoyancy sampling) and rendering (Water.vert.glsl uniforms), so what you
// see is exactly what the bodies feel.
export class WaterSurface {
  constructor({ level = 0 } = {}) {
    this.level = level;       // base water plane height
    this.time = 0;
    this.enabled = true;

    // Wave components: direction (unit 2D), amplitude, wavelength, speed
    this.waves = [
      { dx: 1.0, dz: 0.0,  amplitude: 0.25, wavelength: 9.0,  speed: 2.2 },
      { dx: 0.6, dz: 0.8,  amplitude: 0.12, wavelength: 4.5,  speed: 1.6 },
      { dx: -0.4, dz: 0.9, amplitude: 0.06, wavelength: 2.2,  speed: 1.1 },
    ];
    this.amplitudeScale = 1.0;
  }

  setWaveHeight(h) {
    // h is the total peak amplitude; distribute over components 0.6/0.3/0.1
    this.amplitudeScale = h / 0.43; // baseline sum of amplitudes
  }

  update(dt) { this.time += dt; }

  height(x, z) {
    if (!this.enabled) return this.level;
    let h = this.level;
    const t = this.time;
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      const k = (Math.PI * 2) / w.wavelength;
      const phase = k * (w.dx * x + w.dz * z) - k * w.speed * t;
      h += w.amplitude * this.amplitudeScale * Math.cos(phase);
    }
    return h;
  }

  // Surface normal via finite differences (only needed for splash orientation)
  normal(x, z, out) {
    const e = 0.05;
    const hx1 = this.height(x + e, z), hx0 = this.height(x - e, z);
    const hz1 = this.height(x, z + e), hz0 = this.height(x, z - e);
    out.x = (hx0 - hx1) / (2 * e);
    out.y = 1;
    out.z = (hz0 - hz1) / (2 * e);
    const l = Math.sqrt(out.x * out.x + 1 + out.z * out.z);
    out.x /= l; out.y /= l; out.z /= l;
    return out;
  }
}
