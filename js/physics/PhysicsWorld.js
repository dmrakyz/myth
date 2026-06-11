import { Vec3 } from '../math/Vec3.js';
import { rk4Step } from './Integrator.js';
import { solveConstraints } from './ConstraintSolver.js';
import { Buoyancy } from './Buoyancy.js';
import { resetPools } from '../utils/ObjectPool.js';

// Fixed-substep physics coordinator. Render loop calls step(frameDt) which
// accumulates and runs as many 1/240 s substeps as needed; lerpAlpha exposes
// the leftover fraction for render interpolation.
const FIXED_DT = 1 / 240;
const MAX_SUBSTEPS = 8;
const MAX_SPEED = 80;       // hard velocity clamp, m/s
const MAX_OMEGA = 120;      // hard angular velocity clamp, rad/s
const ROT_DRAG_C = 0.8;     // quadratic rotational drag coefficient
const ROT_DRAG_LIN = 1.6;   // linear (forward-flight) rotational damping coeff
const gravityForce = new Vec3();
const contactW = new Vec3(), contactV = new Vec3(), contactR = new Vec3();
const ct1 = new Vec3(), ct2 = new Vec3(), contactImp = new Vec3();

export class PhysicsWorld {
  constructor({ waterSurface, fluidMedium, terrain = null }) {
    this.water = waterSurface;
    this.medium = fluidMedium;
    this.terrain = terrain;   // optional heightfield; falls back to flat groundY
    this.buoyancy = new Buoyancy(waterSurface);
    this.creatures = [];
    this.gravity = 9.81;
    this.time = 0;
    this.lerpAlpha = 0;
    this.timeScale = 1;
    this.paused = false;
    this.groundY = -50;       // sea floor when no terrain
    this._accumulator = 0;
    this.input = { pitchUp: 0, rollLeft: 0, yawLeft: 0, flapRate: 0, dive: 0, brake: 0 };
  }

  addCreature(creature) { this.creatures.push(creature); }

  removeCreature(creature) {
    const i = this.creatures.indexOf(creature);
    if (i >= 0) this.creatures.splice(i, 1);
  }

  clearCreatures() { this.creatures.length = 0; }

  step(frameDt) {
    if (this.paused) { this.lerpAlpha = 1; return; }
    this._accumulator += Math.min(frameDt, 0.1) * this.timeScale;

    let substeps = 0;
    // Snapshot previous state once per render frame for interpolation
    for (const c of this.creatures) {
      for (const s of c.segments.values()) s.rigidBody.snapshotPrev();
    }

    while (this._accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS) {
      this._substep(FIXED_DT);
      this._accumulator -= FIXED_DT;
      substeps++;
    }
    if (substeps === MAX_SUBSTEPS) this._accumulator = 0; // drop time, avoid spiral
    this.lerpAlpha = this._accumulator / FIXED_DT;
  }

  _substep(dt) {
    this.time += dt;
    this.water.update(dt);
    this.medium.update(dt);
    this.buoyancy.gravity = this.gravity;

    for (const creature of this.creatures) {
      // 1. Muscle target angles from the flapping controller (the impulses
      //    themselves are solved with the joint constraints in step 6)
      if (creature.flappingController) {
        creature.flappingController.update(this.time, dt, this.input);
      }
      // Ground behavior: landing detection, leg support springs, walking
      if (creature.groundController) {
        creature.groundController.update(this, dt, this.input);
      }

      // 2. Fluid forces on every surface
      // Body panels — every segment induces drag/lift
      for (const seg of creature.segments.values()) {
        const body = seg.rigidBody;
        for (let i = 0; i < seg.bodyPanels.length; i++) {
          seg.bodyPanels[i].computeForce(body, this.medium, dt);
        }
      }
      // Wing/fin BET strips
      for (const wing of creature.wings.values()) {
        const seg = creature.segments.get(wing.segmentId);
        if (seg) wing.computeForces(seg.rigidBody, this.medium, dt);
      }
      // Feathers (with passive pitch integration)
      for (const fa of creature.featherArrays.values()) {
        const seg = creature.segments.get(fa.segmentId);
        if (seg) fa.computeForces(seg.rigidBody, this.medium, dt);
      }
      // Membranes (forces on cloth + aggregated onto bones)
      for (const mem of creature.membranes.values()) {
        mem.computeForces(this.medium, dt);
      }

      // 3. Buoyancy + slamming
      this.buoyancy.applyAll(creature);

      // 4. Gravity
      for (const seg of creature.segments.values()) {
        const body = seg.rigidBody;
        gravityForce.set(0, -this.gravity * body.mass, 0);
        body.applyCentralForce(gravityForce);
      }

      // 5. Integrate rigid bodies
      for (const seg of creature.segments.values()) {
        rk4Step(seg.rigidBody, dt);
        seg.rigidBody.clearAccumulators();
      }

      // 6. Joint constraints + muscle motor impulses (interleaved)
      solveConstraints(creature.getJointArray(), dt, 8, [...creature.muscles.values()]);

      // 7. Membrane cloth dynamics (after bones settled)
      for (const mem of creature.membranes.values()) {
        mem.cloth.gravity = this.gravity;
        mem.solve(dt);
      }

      // 8. Rotational fluid damping (implicit — unconditionally stable).
      // Point-strip BET misses the resistance a surface feels rotating about
      // its own axes; without it light bones can spin up unphysically.
      // Two terms, both decaying angular momentum  L ← L / (1 + dt·λ):
      //   quadratic (tumbling):       λ_q = C·ρ·r⁵·|ω| / I_mean
      //   linear (forward flight):    λ_l = C_l·ρ·r⁴·|v| / I_mean
      // The linear term is the pitch/yaw-rate damping derivative (Cm_q): a
      // chordwise-distributed surface moving at airspeed v resists rotation
      // even at small ω. Without it the short-period mode rings undamped —
      // the visible "glide jitter".
      for (const seg of creature.segments.values()) {
        const body = seg.rigidBody;
        const w = Vec3.len(body.angularVelocity);
        if (w > 1e-6) {
          const rho = this.medium.density(body.position);
          const r = seg.boundingRadius;
          const v = Vec3.len(body.velocity);
          const e = body.invInertiaWorld.e;
          const invIMean = (e[0] + e[4] + e[8]) / 3;
          const r4 = r * r * r * r;
          const lambda = rho * r4 * (ROT_DRAG_C * r * w + ROT_DRAG_LIN * v) * invIMean;
          const decay = 1 / (1 + dt * lambda);
          Vec3.scale(body.angMomentum, decay, body.angMomentum);
          body.updateDerived();
        }
      }

      // 9. Safety clamps + sea floor
      for (const seg of creature.segments.values()) {
        const body = seg.rigidBody;
        const v2 = Vec3.lenSq(body.velocity);
        if (v2 > MAX_SPEED * MAX_SPEED) {
          const s = MAX_SPEED / Math.sqrt(v2);
          Vec3.scale(body.linMomentum, s, body.linMomentum);
          body.updateDerived();
        }
        const w2 = Vec3.lenSq(body.angularVelocity);
        if (w2 > MAX_OMEGA * MAX_OMEGA) {
          const s = MAX_OMEGA / Math.sqrt(w2);
          Vec3.scale(body.angMomentum, s, body.angMomentum);
          body.updateDerived();
        }
        // Ground contact: terrain heightfield (or flat sea floor), sampled at
        // the segment's contact points (center + tips of elongated axes).
        // Per-point inelastic normal impulses mean an off-centre strike —
        // a wingtip catching the ground in a dive — pitches/rolls the body
        // like a real wingtip strike instead of silently clipping through.
        // Position projection by the deepest penetration keeps it stable.
        const pts = seg.contactPoints;
        let maxPen = 0, touching = false;
        for (let pi = 0; pi < pts.length; pi++) {
          const cp = pts[pi];
          body.localToWorld(cp.p, contactW);
          const gh = this.terrain
            ? this.terrain.height(contactW.x, contactW.z)
            : this.groundY;
          const pen = gh + cp.r - contactW.y;
          if (pen <= 0) continue;
          touching = true;
          if (pen > maxPen) maxPen = pen;
          body.pointVelocity(contactW, contactV);
          if (contactV.y < 0) {
            // Effective mass at the point along world up:
            //   1/k = 1/m + ŷ·((I⁻¹(r×ŷ))×r)
            Vec3.sub(contactW, body.position, contactR);
            ct1.set(-contactR.z, 0, contactR.x);        // r × ŷ
            const e = body.invInertiaWorld.e;
            ct2.x = e[0] * ct1.x + e[1] * ct1.y + e[2] * ct1.z;
            ct2.y = e[3] * ct1.x + e[4] * ct1.y + e[5] * ct1.z;
            ct2.z = e[6] * ct1.x + e[7] * ct1.y + e[8] * ct1.z;
            Vec3.cross(ct2, contactR, ct1);
            const k = body.invMass + ct1.y;
            if (k > 1e-9) {
              contactImp.set(0, -contactV.y * 0.9 / k, 0);
              body.applyImpulse(contactImp, contactW);
            }
          }
        }
        if (touching) {
          body.position.y += maxPen;
          // Friction: exponential decay of horizontal momentum while touching
          const fr = 1 / (1 + dt * 6);
          body.linMomentum.x *= fr;
          body.linMomentum.z *= fr;
          Vec3.scale(body.angMomentum, 1 / (1 + dt * 4), body.angMomentum);
          body.updateDerived();
        }
      }
    }

    resetPools();
  }
}

export { FIXED_DT };
