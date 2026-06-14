// Updates the DOM HUD elements each frame.
import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';

const FWD = new Vec3(0, 0, -1);
const fwdW = new Vec3();

export class HUD {
  constructor() {
    this._speed = document.getElementById('hud-speed');
    this._alt   = document.getElementById('hud-alt');
    this._glide = document.getElementById('hud-glide');
    this._aoa   = document.getElementById('hud-aoa');
    this._flap  = document.getElementById('hud-flap');
    this._lift  = document.getElementById('hud-lift');
    this._stall = document.getElementById('hud-stall');
    this._medium = document.getElementById('hud-medium');
    this._lastStall = false;
  }

  update(world, creature) {
    if (!creature?.root) return;
    const rb = creature.root.rigidBody;

    // Speed
    const v = rb.velocity;
    const spd = Math.hypot(v.x, v.y, v.z);
    if (this._speed) this._speed.textContent = spd.toFixed(1);

    // Altitude (creature centroid)
    const c = creature.getCentroid();
    const waterLevel = world.waterSurface?.level ?? -10;
    const alt = c.y - waterLevel;
    if (this._alt) this._alt.textContent = alt.toFixed(1);

    // Glide ratio = horizontal distance covered per unit of altitude lost
    // (L/D in steady glide). Only meaningful while descending; climbing or
    // level flight shows ∞.
    if (this._glide) {
      const horiz = Math.hypot(v.x, v.z);
      const sink = -v.y;
      if (sink > 0.15 && horiz > 0.3) {
        const ratio = horiz / sink;
        this._glide.textContent = ratio.toFixed(1);
        this._glide.classList.toggle('hud-bad', ratio < 2);
      } else {
        this._glide.textContent = '∞';
        this._glide.classList.remove('hud-bad');
      }
    }

    // AoA — mean wing strip alpha
    let aoa = 0, nStrips = 0;
    for (const wing of creature.wings.values()) {
      if (wing.name === 'tailSurface' || wing.name === 'tailFin') continue;
      for (const s of wing.strips) {
        aoa += s.lastAlpha; nStrips++;
      }
    }
    const aoaDeg = nStrips > 0 ? (aoa / nStrips) * 57.3 : 0;
    if (this._aoa) this._aoa.textContent = aoaDeg.toFixed(1);

    // Stall warning (AoA > 14°)
    const stalling = Math.abs(aoaDeg) > 14;
    if (stalling !== this._lastStall) {
      this._lastStall = stalling;
      this._stall?.classList.toggle('hidden', !stalling);
    }

    // Flap frequency
    const ctrl = creature.flappingController;
    if (ctrl && this._flap) {
      this._flap.textContent = ctrl.currentFrequency?.toFixed(1) ?? '0.0';
    }

    // Total wing lift
    let lift = 0;
    for (const wing of creature.wings.values()) {
      for (const s of wing.strips) lift += s.lastForce.y;
    }
    for (const fa of creature.featherArrays.values()) {
      for (const f of fa.feathers) lift += f.surface.lastForce.y;
    }
    // Membrane wings (bat/dragon) feed their vertical aero load straight onto
    // the skeleton — count it so the bat's lift readout isn't stuck at zero.
    for (const m of creature.membranes.values()) lift += m.lastLiftY ?? 0;
    if (this._lift) this._lift.textContent = lift.toFixed(1);

    // Medium indicator
    if (this._medium) {
      const submerged = c.y < (waterLevel + 0.5);
      this._medium.textContent = submerged ? '〰 WATER' : '';
    }
  }
}
