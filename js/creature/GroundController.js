import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';
import { clamp } from '../math/MathUtils.js';

// Ground behavior: runs every physics substep (PhysicsWorld step 1).
//
//   APPROACH  — low over land: legs swing down, tail fans for the flare
//   GROUNDED  — torso in contact, slow: legs act as springy landing gear
//               holding the torso at standing height and keeping it upright
//   STANDING  — grounded with flapping stopped: wings tuck against the body;
//               left stick walks (y) and turns (x); flapping again jumps the
//               bird into the air and unfolds the wings
//
// Legs are modeled as two spring-damper struts at the hip anchor points —
// no extra rigid bodies or joints, so the constraint solver is untouched.
const FWD = new Vec3(0, 0, -1);
const fwdW = new Vec3();
const legW = new Vec3();
const legForce = new Vec3();
const walkForce = new Vec3();

export class GroundController {
  constructor(creature, terrain) {
    this.creature = creature;
    this.terrain = terrain;

    this.legExtend = 0;        // 0 tucked .. 1 extended (renderer reads this)
    this.grounded = false;
    this.standing = false;

    this.approachAgl = 6;      // legs come down below this height over land
    this.standHeight = 0.16;   // torso-center height the leg struts hold
    this.legK = 110;           // strut stiffness (N/m) per leg
    this.legC = 9;             // strut damping (N·s/m) per leg
    this.walkForceN = 2.2;     // walk drive force (N)
    this.turnTorque = 0.12;    // yaw torque from stick x (N·m)
    this.jumpSpeed = 4.0;      // takeoff leap, vertical (m/s)
    this.jumpForward = 3.0;    // takeoff leap, along heading (m/s) — birds
                               // leap up-and-forward to reach flying speed
                               // before the first downstroke

    // Hip anchor points in torso frame (match the leg visual attachments)
    this.legAnchors = [new Vec3(0.028, -0.055, 0.015), new Vec3(-0.028, -0.055, 0.015)];
    this._jumpLatch = false;
  }

  update(world, dt, input) {
    const c = this.creature;
    const root = c.root;
    if (!root || !this.terrain) return;
    const rb = root.rigidBody;
    const p = rb.position;

    const gh = this.terrain.height(p.x, p.z);
    const overLand = gh > this.terrain.seaLevel + 0.05;
    const agl = p.y - gh;
    const speed = Math.hypot(rb.velocity.x, rb.velocity.y, rb.velocity.z);
    const flap = clamp(input.flapRate, 0, 1);

    // ── State detection (with hysteresis) ──────────────────────────────────
    if (!this.grounded) {
      if (overLand && agl < this.standHeight + 0.12 && speed < 3.5) this.grounded = true;
    } else if (agl > 0.8 || !overLand) {
      this.grounded = false;
    }
    this.standing = this.grounded && flap < 0.3;

    // ── Leg extension: down on approach/ground, tucked in cruise ──────────
    const wantLegs = this.grounded || (overLand && agl < this.approachAgl && rb.velocity.y < 1);
    this.legExtend += ((wantLegs ? 1 : 0) - this.legExtend) * Math.min(1, dt * 4);
    c.legExtend = this.legExtend;

    // ── Tail fans for the landing flare ────────────────────────────────────
    const ctrl = c.flappingController;
    if (ctrl) {
      ctrl.spreadDemand = (!this.grounded && wantLegs) ? 1 : (this.grounded ? 0.3 : 0);
      // Wings fold when standing, unfold the moment flapping resumes
      const tuckTgt = this.standing ? 1 : 0;
      ctrl.tuck += (tuckTgt - ctrl.tuck) * Math.min(1, dt * 3);
    }

    // ── Leg struts: springy landing gear at the two hip anchors ───────────
    if (this.legExtend > 0.3 && agl < this.standHeight + 0.1) {
      for (const anchor of this.legAnchors) {
        Quat.rotateVec(rb.orientation, anchor, legW);
        legW.x += p.x; legW.y += p.y; legW.z += p.z;
        const legGh = this.terrain.height(legW.x, legW.z);
        // Strut compression measured at the hip: supports torso at standHeight
        const compress = (legGh + this.standHeight + anchor.y) - legW.y;
        if (compress > 0) {
          rb.pointVelocity(legW, legForce);
          const vUp = legForce.y;
          const f = Math.max(0, this.legK * this.legExtend * compress - this.legC * vUp);
          legForce.set(0, f, 0);
          rb.applyForce(legForce, legW);
        }
      }
    }

    // ── Walking / turning with the left stick while standing ──────────────
    if (this.standing) {
      Quat.rotateVec(rb.orientation, FWD, fwdW);
      const hl = Math.hypot(fwdW.x, fwdW.z) || 1;
      const drive = this.walkForceN * clamp(input.pitchUp, -1, 1);
      walkForce.set(fwdW.x / hl * drive, 0, fwdW.z / hl * drive);
      rb.applyCentralForce(walkForce);
      // Turn in place: yaw torque about world up
      const tq = this.turnTorque * clamp(input.rollLeft, -1, 1);
      rb.angMomentum.y += tq * dt;
      rb.updateDerived();
    }

    // ── Jump / takeoff: flapping while grounded leaps up-and-forward ──────
    if (this.grounded && flap > 0.5) {
      if (!this._jumpLatch) {
        this._jumpLatch = true;
        Quat.rotateVec(rb.orientation, FWD, fwdW);
        const hl = Math.hypot(fwdW.x, fwdW.z) || 1;
        const jx = fwdW.x / hl * this.jumpForward;
        const jz = fwdW.z / hl * this.jumpForward;
        for (const seg of c.segments.values()) {
          const b = seg.rigidBody;
          b.linMomentum.x += jx * b.mass;
          b.linMomentum.y += this.jumpSpeed * b.mass;
          b.linMomentum.z += jz * b.mass;
          b.updateDerived();
        }
        this.grounded = false;
        if (ctrl) ctrl.tuck = 0;
      }
    } else if (flap < 0.3) {
      this._jumpLatch = false;
    }
  }
}
