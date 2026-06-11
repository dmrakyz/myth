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
const ROT_DRAG_C = 0.8;     // rotational drag coefficient
const gravityForce = new Vec3();

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
      // Quadratic-drag decay applied directly to angular momentum:
      //   L ← L / (1 + dt·λ),  λ = C·ρ·r⁵·|ω| / I_mean
      for (const seg of creature.segments.values()) {
        const body = seg.rigidBody;
        const w = Vec3.len(body.angularVelocity);
        if (w > 1e-6) {
          const rho = this.medium.density(body.position);
          const r = seg.boundingRadius;
          const e = body.invInertiaWorld.e;
          const invIMean = (e[0] + e[4] + e[8]) / 3;
          const lambda = ROT_DRAG_C * rho * r * r * r * r * r * w * invIMean;
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
        // Ground contact: terrain heightfield (or flat sea floor). Position
        // projection + inelastic bounce + tangential friction decay — simple,
        // unconditionally stable, and enough for standing/walking.
        const cr = seg.contactRadius ?? seg.boundingRadius;
        const gh = this.terrain
          ? this.terrain.height(body.position.x, body.position.z)
          : this.groundY;
        if (body.position.y < gh + cr) {
          body.position.y = gh + cr;
          if (body.linMomentum.y < 0) body.linMomentum.y *= -0.2;
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
