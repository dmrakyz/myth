import { Vec3 } from '../math/Vec3.js';
import { clamp, wrapAngle } from '../math/MathUtils.js';

// Rotational actuator at a hinge joint, solved as an implicit spring-damper
// motor impulse (Box2D-style soft constraint). Implicit integration of the
// 1-DOF system  I·ω̇ = k(θ_target − θ) − c·ω  is unconditionally stable for
// any stiffness/damping, which matters because wing bones have tiny inertia
// compared to muscle torques. Total impulse per substep is clamped to
// maxTorque·dt — the physical strength limit of the muscle.
const axisW = new Vec3();
const relW = new Vec3();
const imp = new Vec3();

export class Muscle {
  constructor({
    joint,
    stiffness = 80,     // N·m/rad
    damping = 8,        // N·m·s/rad
    maxTorque = 30,     // N·m
    restAngle = 0,
  }) {
    this.joint = joint;
    this.stiffness = stiffness;
    this.damping = damping;
    this.maxTorque = maxTorque;
    this.targetAngle = restAngle;
    this.restAngle = restAngle;
    this.enabled = true;
    this.lastTorque = 0;   // λ_total/dt, for HUD
    this.workDone = 0;     // accumulated positive muscle work (J)
    this._accImpulse = 0;  // accumulated angular impulse this substep
  }

  setTargetAngle(theta) { this.targetAngle = theta; }

  beginSubstep() { this._accImpulse = 0; }

  // One solver iteration: compute and apply the implicit motor impulse.
  solveIteration(dt) {
    if (!this.enabled || this.joint.broken) return;
    const j = this.joint;
    const a = j.bodyA, b = j.bodyB;

    a.localDirToWorld(j.axisA, axisW);

    // Effective angular inertia about the hinge axis: 1/I_eff = ka + kb
    const ea = a.invInertiaWorld.e, eb = b.invInertiaWorld.e;
    const ka = a.kinematic ? 0 :
        axisW.x * (ea[0] * axisW.x + ea[1] * axisW.y + ea[2] * axisW.z)
      + axisW.y * (ea[3] * axisW.x + ea[4] * axisW.y + ea[5] * axisW.z)
      + axisW.z * (ea[6] * axisW.x + ea[7] * axisW.y + ea[8] * axisW.z);
    const kb = b.kinematic ? 0 :
        axisW.x * (eb[0] * axisW.x + eb[1] * axisW.y + eb[2] * axisW.z)
      + axisW.y * (eb[3] * axisW.x + eb[4] * axisW.y + eb[5] * axisW.z)
      + axisW.z * (eb[6] * axisW.x + eb[7] * axisW.y + eb[8] * axisW.z);
    const invI = ka + kb;
    if (invI < 1e-12) return;
    const I = 1 / invI;

    const angle = j.getHingeAngle();
    const err = wrapAngle(this.targetAngle - angle);

    Vec3.sub(b.angularVelocity, a.angularVelocity, relW);
    const omega = Vec3.dot(relW, axisW);

    // Implicit Euler solution of I·ω̇ = k·err − c·ω over dt:
    //   ω⁺ = (I·ω + dt·k·err) / (I + dt·c + dt²·k)
    const h = dt;
    const omegaNew = (I * omega + h * this.stiffness * err) /
                     (I + h * this.damping + h * h * this.stiffness);
    let dLambda = I * (omegaNew - omega);

    // Clamp accumulated impulse to the muscle's physical torque limit
    const maxImpulse = this.maxTorque * dt;
    const old = this._accImpulse;
    this._accImpulse = clamp(old + dLambda, -maxImpulse, maxImpulse);
    dLambda = this._accImpulse - old;
    if (dLambda === 0) return;

    Vec3.scale(axisW, dLambda, imp);
    if (!b.kinematic) {
      b.angMomentum.x += imp.x; b.angMomentum.y += imp.y; b.angMomentum.z += imp.z;
      b.updateDerived();
    }
    if (!a.kinematic) {
      a.angMomentum.x -= imp.x; a.angMomentum.y -= imp.y; a.angMomentum.z -= imp.z;
      a.updateDerived();
    }

    this.lastTorque = this._accImpulse / dt;
    this.workDone += Math.max(0, dLambda * omega);
  }
}
