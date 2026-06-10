import { Vec3 } from '../math/Vec3.js';
import { clamp } from '../math/MathUtils.js';
import { WATER_RHO } from '../fluid/FluidMedium.js';
import { EventBus } from '../utils/EventBus.js';

// Archimedes buoyancy per segment plus water-entry slamming load.
// Submerged fraction is approximated from the segment's bounding radius vs.
// the local wave height — exact volume integration is unnecessary at this
// scale and the smooth approximation avoids force discontinuities.
const buoyForce = new Vec3();
const dragForce = new Vec3();
const center = new Vec3();

export class Buoyancy {
  constructor(waterSurface) {
    this.water = waterSurface;
    this.gravity = 9.81;
    // segment.id → was-submerged flag for edge-triggered splash events
    this._wasSubmerged = new Map();
  }

  applySegment(segment) {
    const body = segment.rigidBody;
    const r = segment.boundingRadius;
    const pos = body.position;
    const waterH = this.water.height(pos.x, pos.z);

    // Fraction of the bounding sphere below the surface
    const depth = waterH - (pos.y - r);            // 0 at touch, 2r fully under
    const frac = clamp(depth / (2 * r), 0, 1);
    // Smooth sphere-cap volume fraction: 3t² - 2t³ matches sphere immersion
    // much better than linear
    const volFrac = frac * frac * (3 - 2 * frac);

    const wasSub = this._wasSubmerged.get(segment.id) || false;
    const isSub = volFrac > 0.02;

    if (isSub) {
      // Buoyant force at the centroid of the submerged cap (approximate:
      // shifted down from center by (1-volFrac)·r/2)
      const fb = WATER_RHO * segment.volume * volFrac * this.gravity;
      buoyForce.set(0, fb, 0);
      center.copy(pos);
      center.y -= (1 - volFrac) * r * 0.5;
      body.applyForce(buoyForce, center);

      // Viscous water damping — water is far more dissipative than the BET
      // panel drag alone captures for a tumbling body. Linear in velocity.
      const damp = -6 * Math.PI * 0.001 * r * 800 * volFrac; // scaled Stokes-ish
      Vec3.scale(body.velocity, damp, dragForce);
      body.applyCentralForce(dragForce);
      // Rotational damping
      dragForce.x = body.angularVelocity.x * damp * r * r * 0.3;
      dragForce.y = body.angularVelocity.y * damp * r * r * 0.3;
      dragForce.z = body.angularVelocity.z * damp * r * r * 0.3;
      body.applyTorque(dragForce);
    }

    // Edge-triggered slamming load on water entry
    if (isSub && !wasSub && body.velocity.y < -0.5) {
      const vEntry = -body.velocity.y;
      const crossArea = Math.PI * r * r;
      // Impulse form of slamming: F·dt ≈ ½ ρ v² A · τ with τ ~ r/v (immersion time)
      const impulse = 0.5 * WATER_RHO * vEntry * crossArea * r * 0.4;
      buoyForce.set(0, impulse, 0);
      body.applyImpulse(buoyForce, pos);
      EventBus.emit('waterEntry', {
        x: pos.x, y: waterH, z: pos.z,
        speed: vEntry, radius: r,
      });
    } else if (!isSub && wasSub) {
      EventBus.emit('waterExit', { x: pos.x, y: waterH, z: pos.z, radius: r });
    }
    this._wasSubmerged.set(segment.id, isSub);
  }

  applyAll(creature) {
    if (!this.water.enabled) return;
    for (const segment of creature.segments.values()) {
      this.applySegment(segment);
    }
  }
}
