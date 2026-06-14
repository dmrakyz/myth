import { Vec3 } from '../math/Vec3.js';
import { ClothBody } from '../physics/ClothBody.js';
import { forceLimitScale } from '../fluid/ForceLimiter.js';

// Membrane wing (bat/dragon): an XPBD cloth grid stretched between a chain
// of wing bones (leading edge) and a trailing anchor (torso/leg side).
//
// Aerodynamics: per-particle normal-pressure model. For thin separated
// membranes the section force is dominated by normal pressure:
//   F = -½ ρ A Cn (v·n̂)|v·n̂| n̂      (Cn ≈ 1.8 for a billowed membrane)
// Forces act on the cloth (shaping the billow) AND are aggregated onto the
// supporting bones so the creature actually feels membrane lift — one-way
// structural coupling, full aerodynamic coupling.
const pPos = new Vec3();
const pVel = new Vec3();
const flowV = new Vec3();
const relV = new Vec3();
const nrm = new Vec3();
const e1 = new Vec3();
const e2 = new Vec3();
const f = new Vec3();
const CN = 1.8;

let nextMembraneId = 1;

export class WingMembrane {
  constructor({
    name = 'membrane',
    // pins: array of { segment, localPoint:Vec3, col, row } — grid nodes
    // welded to bones. Remaining nodes are free cloth.
    cols, rows,
    pins = [],
    initialPositions,      // Float64Array or array of [x,y,z] per node, world
    areaPerParticle = null,
    compliance = 2e-5,     // membrane stretch compliance (skin is stretchy)
    particleMass = 0.004,
    color = 0x6b4a3a,      // leathery skin tone (renderer reads this)
  }) {
    this.id = `mem_${nextMembraneId++}`;
    this.name = name;
    this.color = color;
    this.cols = cols;
    this.rows = rows;
    this.cloth = new ClothBody(cols * rows);
    this.pins = pins;
    this.lastTotalForce = 0;

    for (let i = 0; i < cols * rows; i++) {
      const p = initialPositions[i];
      this.cloth.setParticle(i, p[0], p[1], p[2], particleMass);
    }

    // Structural + shear constraints
    const idx = (c, r) => r * cols + c;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (c + 1 < cols) this.cloth.addDistanceConstraint(idx(c, r), idx(c + 1, r), compliance);
        if (r + 1 < rows) this.cloth.addDistanceConstraint(idx(c, r), idx(c, r + 1), compliance);
        if (c + 1 < cols && r + 1 < rows) {
          this.cloth.addDistanceConstraint(idx(c, r), idx(c + 1, r + 1), compliance * 2);
          this.cloth.addDistanceConstraint(idx(c + 1, r), idx(c, r + 1), compliance * 2);
        }
        // Bend resistance: skip-one constraints, soft
        if (c + 2 < cols) this.cloth.addDistanceConstraint(idx(c, r), idx(c + 2, r), compliance * 8);
        if (r + 2 < rows) this.cloth.addDistanceConstraint(idx(c, r), idx(c, r + 2), compliance * 8);
      }
    }

    for (const pin of pins) {
      this.cloth.addPin(idx(pin.col, pin.row), pin.segment.rigidBody, pin.localPoint);
    }

    // Each free particle routes its aero force to the rigid body of the
    // nearest pinned grid node, so membrane lift loads the correct bone.
    this._forceTarget = new Array(cols * rows).fill(null);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let best = null, bestD = Infinity;
        for (const pin of pins) {
          const d = (pin.col - c) * (pin.col - c) + (pin.row - r) * (pin.row - r);
          if (d < bestD) { bestD = d; best = pin.segment.rigidBody; }
        }
        this._forceTarget[r * cols + c] = best;
      }
    }

    // Approximate per-particle area from the initial grid
    if (areaPerParticle) {
      this.areaPerParticle = areaPerParticle;
    } else {
      let totalArea = 0;
      for (let r = 0; r + 1 < rows; r++) {
        for (let c = 0; c + 1 < cols; c++) {
          const a = initialPositions[idx(c, r)];
          const b = initialPositions[idx(c + 1, r)];
          const d = initialPositions[idx(c, r + 1)];
          const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const ad = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
          const cx = ab[1] * ad[2] - ab[2] * ad[1];
          const cy = ab[2] * ad[0] - ab[0] * ad[2];
          const cz = ab[0] * ad[1] - ab[1] * ad[0];
          totalArea += Math.sqrt(cx * cx + cy * cy + cz * cz);
        }
      }
      this.areaPerParticle = totalArea / (cols * rows);
    }
  }

  _particleNormal(c, r, out) {
    // Normal from neighboring grid points (central differences clamped at edges)
    const idx = (cc, rr) => (rr * this.cols + cc) * 3;
    const pos = this.cloth.pos;
    const c0 = Math.max(0, c - 1), c1 = Math.min(this.cols - 1, c + 1);
    const r0 = Math.max(0, r - 1), r1 = Math.min(this.rows - 1, r + 1);
    e1.set(pos[idx(c1, r)] - pos[idx(c0, r)],
           pos[idx(c1, r) + 1] - pos[idx(c0, r) + 1],
           pos[idx(c1, r) + 2] - pos[idx(c0, r) + 2]);
    e2.set(pos[idx(c, r1)] - pos[idx(c, r0)],
           pos[idx(c, r1) + 1] - pos[idx(c, r0) + 1],
           pos[idx(c, r1) + 2] - pos[idx(c, r0) + 2]);
    Vec3.cross(e1, e2, out);
    return Vec3.norm(out, out);
  }

  computeForces(medium, dt) {
    let total = 0;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c;
        this.cloth.getPos(i, pPos);
        this.cloth.getVel(i, pVel);
        medium.flow(pPos, flowV);
        Vec3.sub(pVel, flowV, relV);

        this._particleNormal(c, r, nrm);
        const vn = Vec3.dot(relV, nrm);
        const rho = medium.density(pPos);
        const mag = -0.5 * rho * this.areaPerParticle * CN * vn * Math.abs(vn);
        Vec3.scale(nrm, mag, f);

        // Shape force on the cloth
        this.cloth.addForce(i, f.x, f.y, f.z);

        // Flight force on the skeleton, applied at the particle position so
        // the supporting bone feels the correct torque. Limited for explicit
        // integration stability on light bones (see ForceLimiter.js).
        const target = this._forceTarget[i];
        if (target) {
          const scale = forceLimitScale(target, pPos, f, Vec3.len(relV), dt);
          if (scale < 1) Vec3.scale(f, scale, f);
          target.applyForce(f, pPos);
        }

        total += Math.abs(mag);
      }
    }
    this.lastTotalForce = total;
    return total;
  }

  solve(dt) {
    this.cloth.solve(dt, 4);
  }

  // Seed every free particle's velocity (e.g. when the creature is launched).
  // Without this the cloth starts at rest while the skeleton moves, so the
  // pins snap the membrane on the first frame and spike force into the bones.
  setUniformVelocity(vx, vy, vz) {
    const vel = this.cloth.vel, inv = this.cloth.invMass;
    for (let i = 0; i < this.cloth.count; i++) {
      if (inv[i] === 0) continue;
      vel[i * 3] = vx; vel[i * 3 + 1] = vy; vel[i * 3 + 2] = vz;
    }
  }
}
