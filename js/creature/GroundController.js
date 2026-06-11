import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';
import { clamp } from '../math/MathUtils.js';

// Ground behavior: runs every physics substep (PhysicsWorld step 1).
//
//   APPROACH  — low over land: legs swing down, tail fans for the flare
//   GROUNDED  — torso in contact, slow: leg spring struts hold stand height;
//               PD upright torque keeps the bird level on any slope
//   STANDING  — grounded with low speed (< 2 m/s regardless of flapRate):
//               wings tuck against the body; alternating-gait leg forces walk
//               the bird along its heading; flapping again jumps it airborne
const TWO_PI = Math.PI * 2;
const FWD   = new Vec3(0, 0, -1);
const UP    = new Vec3(0, 1, 0);
const RIGHT = new Vec3(1, 0, 0);
const fwdW    = new Vec3();
const upW     = new Vec3();
const rightW  = new Vec3();
const legW    = new Vec3();
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
    this.standHeight = 0.16;   // torso-center height held by leg struts
    this.legK = 110;            // strut stiffness N/m per leg
    this.legC = 9;              // strut damping N·s/m per leg
    this.walkForceN = 2.2;      // forward drive force per gait cycle (N)
    this.footFriction = 1.2;    // ground grip N·s/m — kills residual slide
    this.turnTorque = 0.12;     // yaw torque from stick x (N·m)
    this.jumpSpeed = 4.5;       // takeoff vertical impulse (m/s)
    this.jumpForward = 4.5;     // takeoff forward impulse (m/s)

    // Upright PD: torque along upW × worldUp rights the bird from any
    // attitude (no small-angle breakdown when it lands beak-first)
    this.uprightK = 2.2;        // righting spring N·m/rad
    this.uprightC = 0.35;       // tumble damping N·m·s/rad
    this.uprightCYaw = 0.20;    // yaw rate damping N·m·s/rad

    // Physical walking gait: alternating leg stance phases
    this.gaitPhase = 0;
    this.gaitFreq  = 2.5;      // step cycles per second

    // Hip anchor points in torso frame (match leg visual attachments)
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
    // Physical standing: grounded + low speed. Used for upright correction and
    // gait-based walking. Tuck uses a separate flap-threshold so full flapRate
    // keeps wings ready for takeoff while LAND mode (flapRate=0.25) folds them.
    this.standing = this.grounded && speed < 2.0;

    // ── Leg extension: down on approach/ground, tucked in cruise ──────────
    const wantLegs = this.grounded || (overLand && agl < this.approachAgl && rb.velocity.y < 1);
    this.legExtend += ((wantLegs ? 1 : 0) - this.legExtend) * Math.min(1, dt * 4);
    c.legExtend = this.legExtend;

    // ── Tail fans for the landing flare ───────────────────────────────────
    const ctrl = c.flappingController;
    if (ctrl) {
      ctrl.spreadDemand = (!this.grounded && wantLegs) ? 1 : (this.grounded ? 0.3 : 0);
      // Wings tuck when grounded with low flapRate (< 0.3). This means:
      //  • LAND mode (flapRate = 0.25): wings fold on touchdown  ✓
      //  • FLAP mode on ground (flapRate = 1): wings stay ready  ✓ (test passes)
      const tuckTgt = (this.grounded && flap < 0.3) ? 1 : 0;
      ctrl.tuck += (tuckTgt - ctrl.tuck) * Math.min(1, dt * 3);
      // Takeoff assist: while flapping hard near the ground, tell the flight
      // reflex this climb is intentional (suppresses the phugoid damper that
      // otherwise noses over at every hop apex). Fades out by 4 m AGL.
      ctrl.takeoffAssist = (flap > 0.5 && overLand)
        ? clamp(1 - agl / 4, 0, 1) : 0;
    }

    // ── Leg struts: springy landing gear at the two hip anchors ───────────
    if (this.legExtend > 0.3 && agl < this.standHeight + 0.1) {
      for (const anchor of this.legAnchors) {
        Quat.rotateVec(rb.orientation, anchor, legW);
        legW.x += p.x; legW.y += p.y; legW.z += p.z;
        const legGh = this.terrain.height(legW.x, legW.z);
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

    // ── Foot friction: grip kills residual horizontal slide on contact.
    //    Fades out with flap input — a bird in its takeoff run is up on its
    //    toes, not digging in; full grip would eat the hop-run's speed. ──
    if (this.grounded) {
      const grip = this.footFriction * (1 - flap);
      legForce.set(-grip * rb.velocity.x, 0, -grip * rb.velocity.z);
      rb.applyForce(legForce, p);
    }

    // ── Upright correction: active on the ground and through low hops, so
    //    the bird holds attitude during a hop-run takeoff instead of
    //    tumbling. While flapping hard the target attitude is NOSE-UP (the
    //    takeoff posture real birds hold), so the righting spring promotes
    //    the climb-out instead of clamping the bird level; above 1.2 m AGL
    //    the assist is gone and the flight reflexes own the attitude.
    if (this.grounded || (overLand && agl < 1.2 && this.legExtend > 0.3
        && (speed < 4.5 || flap > 0.5))) {
      Quat.rotateVec(rb.orientation, UP, upW);
      const w = rb.angularVelocity;

      // Target up vector: world-up during the acceleration run, tilting
      // backward (nose-up rotation) as airspeed builds past 5.5 m/s — the
      // two-phase takeoff real birds fly: stay flat and fast in ground
      // effect first, rotate and climb only with speed in hand. Righting
      // torque along upW × target; magnitude = sin(tilt error).
      let tx = 0, ty = 1, tz = 0;
      const rot = 0.25 * clamp((speed - 5.5) / 2, 0, 1);
      if (flap > 0.5 && !this.standing && rot > 0.01) {
        Quat.rotateVec(rb.orientation, FWD, fwdW);
        const hl = Math.hypot(fwdW.x, fwdW.z) || 1;
        tx = -fwdW.x / hl * rot; tz = -fwdW.z / hl * rot;
        const tl = Math.hypot(tx, 1, tz);
        tx /= tl; ty = 1 / tl; tz /= tl;
      }
      const k = this.uprightK;
      rb.angMomentum.x += k * (upW.y * tz - upW.z * ty) * dt;
      rb.angMomentum.y += k * (upW.z * tx - upW.x * tz) * dt;
      rb.angMomentum.z += k * (upW.x * ty - upW.y * tx) * dt;

      // Tumble damping on roll/pitch rates, lighter damping on yaw rate so
      // gait hip-anchor torques don't accumulate into heading drift
      const yawRate = w.x * upW.x + w.y * upW.y + w.z * upW.z;
      const cT = this.uprightC, cY = this.uprightCYaw;
      rb.angMomentum.x += (-cT * (w.x - yawRate * upW.x) - cY * yawRate * upW.x) * dt;
      rb.angMomentum.y += (-cT * (w.y - yawRate * upW.y) - cY * yawRate * upW.y) * dt;
      rb.angMomentum.z += (-cT * (w.z - yawRate * upW.z) - cY * yawRate * upW.z) * dt;

      rb.updateDerived();
    }

    // ── Walking + turning (only when standing) ────────────────────────────
    if (this.standing) {
      Quat.rotateVec(rb.orientation, FWD, fwdW);
      const hl = Math.hypot(fwdW.x, fwdW.z) || 1;

      // Physical gait: alternating leg stance phases so each foot pushes in
      // turn — the off-centre force application creates the natural side-to-side
      // sway of a walking bird rather than a smooth floating glide.
      const drive = this.walkForceN * clamp(input.pitchUp, -1, 1);
      if (Math.abs(drive) > 0.01) this.gaitPhase += this.gaitFreq * TWO_PI * dt;

      for (let i = 0; i < 2; i++) {
        const stance = Math.max(0, Math.sin(this.gaitPhase + i * Math.PI));
        Quat.rotateVec(rb.orientation, this.legAnchors[i], legW);
        legW.x += p.x; legW.y += p.y; legW.z += p.z;
        walkForce.set(fwdW.x / hl * drive * stance * 2,
                      0,
                      fwdW.z / hl * drive * stance * 2);
        rb.applyForce(walkForce, legW);
      }

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
        this._airTime = 0;
        if (ctrl) ctrl.tuck = 0;
      }
    } else if (flap < 0.3) {
      this._jumpLatch = false;
    }
    // Hop-run takeoff: once airborne for a moment the latch re-arms, so a
    // still-flapping bird that touches down again immediately hops onward,
    // building airspeed until the wings carry it.
    if (!this.grounded) {
      this._airTime = (this._airTime || 0) + dt;
      if (this._airTime > 0.4) this._jumpLatch = false;
    } else {
      this._airTime = 0;
    }
  }
}
