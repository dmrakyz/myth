import { Vec3 } from '../math/Vec3.js';
import { clamp } from '../math/MathUtils.js';

// Sequential impulse solver for joints. Velocity-level constraints with
// Baumgarte positional stabilization. Runs after integration each substep.
// The angular coefficient is deliberately stiffer: sustained aerodynamic
// moments on light wing bones otherwise hold hinge axes visibly misaligned
// (a steady-state constraint violation that twists wing incidence).
const BAUMGARTE = 0.25;
const BAUMGARTE_ANG = 0.6;

// Scratch
const rA = new Vec3(), rB = new Vec3();
const pA = new Vec3(), pB = new Vec3();
const vA = new Vec3(), vB = new Vec3();
const relV = new Vec3(), err = new Vec3();
const imp = new Vec3(), tmp = new Vec3(), tmp2 = new Vec3();
const axisWA = new Vec3(), axisWB = new Vec3();
const corr = new Vec3();
const emRxn = new Vec3(), emI = new Vec3(), emCross = new Vec3();

function effectiveMassPoint(body, r, n) {
  // 1/m + nᵀ ((I⁻¹ (r × n)) × r) along direction n — uses its own scratch
  // vectors because callers pass shared scratch as n.
  if (body.kinematic) return 0;
  Vec3.cross(r, n, emRxn);
  const e = body.invInertiaWorld.e;
  emI.x = e[0] * emRxn.x + e[1] * emRxn.y + e[2] * emRxn.z;
  emI.y = e[3] * emRxn.x + e[4] * emRxn.y + e[5] * emRxn.z;
  emI.z = e[6] * emRxn.x + e[7] * emRxn.y + e[8] * emRxn.z;
  Vec3.cross(emI, r, emCross);
  return body.invMass + Vec3.dot(emCross, n);
}

function solvePointConstraint(joint, invDt) {
  const a = joint.bodyA, b = joint.bodyB;

  joint.worldPivotA(pA);
  joint.worldPivotB(pB);
  Vec3.sub(pA, a.position, rA);
  Vec3.sub(pB, b.position, rB);

  a.pointVelocity(pA, vA);
  b.pointVelocity(pB, vB);
  Vec3.sub(vB, vA, relV);

  // Positional error pushed into velocity target (Baumgarte)
  Vec3.sub(pB, pA, err);
  Vec3.addScaled(relV, err, BAUMGARTE * invDt, relV);

  // Solve each axis independently (3 sequential 1D constraints — stable
  // enough at 240 Hz and far cheaper than a 3x3 block solve)
  for (let axis = 0; axis < 3; axis++) {
    tmp.set(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
    const vRel = axis === 0 ? relV.x : axis === 1 ? relV.y : relV.z;
    const k = effectiveMassPoint(a, rA, tmp) + effectiveMassPoint(b, rB, tmp);
    if (k < 1e-12) continue;
    const lambda = -vRel / k;
    Vec3.scale(tmp, lambda, imp);

    Vec3.negate(imp, tmp2);
    a.applyImpulse(tmp2, pA);
    b.applyImpulse(imp, pB);

    // Refresh relative velocity for the remaining axes
    a.pointVelocity(pA, vA);
    b.pointVelocity(pB, vB);
    Vec3.sub(vB, vA, relV);
    Vec3.addScaled(relV, err, BAUMGARTE * invDt, relV);
  }
}

function applyAngularImpulse(body, L, sign) {
  if (body.kinematic) return;
  body.angMomentum.x += sign * L.x;
  body.angMomentum.y += sign * L.y;
  body.angMomentum.z += sign * L.z;
  body.updateDerived();
}

function solveAxisAlignment(joint, invDt) {
  // Constrain bodyB's hinge axis to align with bodyA's: removes the two
  // angular DOF perpendicular to the hinge axis.
  const a = joint.bodyA, b = joint.bodyB;
  a.localDirToWorld(joint.axisA, axisWA);
  b.localDirToWorld(joint.axisB, axisWB);

  // Constraint error: axisWB should equal axisWA → error = axisWA × axisWB
  Vec3.cross(axisWB, axisWA, err);

  // Relative angular velocity perpendicular to hinge axis
  Vec3.sub(b.angularVelocity, a.angularVelocity, relV);
  const along = Vec3.dot(relV, axisWA);
  Vec3.addScaled(relV, axisWA, -along, relV);

  Vec3.addScaled(relV, err, -BAUMGARTE_ANG * invDt, corr);

  // Effective angular mass (scalar approx along correction direction)
  const len = Vec3.len(corr);
  if (len < 1e-10) return;
  Vec3.scale(corr, 1 / len, tmp);

  const ea = a.invInertiaWorld.e, eb = b.invInertiaWorld.e;
  const ka = a.kinematic ? 0 : tmp.x * (ea[0] * tmp.x + ea[1] * tmp.y + ea[2] * tmp.z)
           + tmp.y * (ea[3] * tmp.x + ea[4] * tmp.y + ea[5] * tmp.z)
           + tmp.z * (ea[6] * tmp.x + ea[7] * tmp.y + ea[8] * tmp.z);
  const kb = b.kinematic ? 0 : tmp.x * (eb[0] * tmp.x + eb[1] * tmp.y + eb[2] * tmp.z)
           + tmp.y * (eb[3] * tmp.x + eb[4] * tmp.y + eb[5] * tmp.z)
           + tmp.z * (eb[6] * tmp.x + eb[7] * tmp.y + eb[8] * tmp.z);
  const k = ka + kb;
  if (k < 1e-12) return;

  const lambda = -len / k;
  Vec3.scale(tmp, lambda, imp);
  applyAngularImpulse(a, imp, -1);
  applyAngularImpulse(b, imp, +1);
}

function solveHingeLimits(joint, invDt) {
  if (!joint.limits) return;
  const angle = joint.getHingeAngle();
  const { min, max } = joint.limits;
  let violation = 0;
  if (angle < min) violation = angle - min;
  else if (angle > max) violation = angle - max;
  else return;

  const a = joint.bodyA, b = joint.bodyB;
  a.localDirToWorld(joint.axisA, axisWA);

  Vec3.sub(b.angularVelocity, a.angularVelocity, relV);
  const wRel = Vec3.dot(relV, axisWA);
  const target = wRel + BAUMGARTE * invDt * violation;

  // Only push back toward the limit
  if ((violation < 0 && target > 0) || (violation > 0 && target < 0)) return;

  const ea = a.invInertiaWorld.e, eb = b.invInertiaWorld.e;
  const ka = a.kinematic ? 0 : axisWA.x * (ea[0] * axisWA.x + ea[1] * axisWA.y + ea[2] * axisWA.z)
           + axisWA.y * (ea[3] * axisWA.x + ea[4] * axisWA.y + ea[5] * axisWA.z)
           + axisWA.z * (ea[6] * axisWA.x + ea[7] * axisWA.y + ea[8] * axisWA.z);
  const kb = b.kinematic ? 0 : axisWA.x * (eb[0] * axisWA.x + eb[1] * axisWA.y + eb[2] * axisWA.z)
           + axisWA.y * (eb[3] * axisWA.x + eb[4] * axisWA.y + eb[5] * axisWA.z)
           + axisWA.z * (eb[6] * axisWA.x + eb[7] * axisWA.y + eb[8] * axisWA.z);
  const k = ka + kb;
  if (k < 1e-12) return;

  const lambda = -target / k;
  Vec3.scale(axisWA, lambda, imp);
  applyAngularImpulse(a, imp, -1);
  applyAngularImpulse(b, imp, +1);
}

function solveFixedOrientation(joint, invDt) {
  // Lock relative orientation entirely: drive relative ω to zero plus
  // orientation error correction via the two-axis trick applied on all axes.
  const a = joint.bodyA, b = joint.bodyB;
  a.localDirToWorld(joint.axisA, axisWA);
  b.localDirToWorld(joint.axisB, axisWB);
  Vec3.cross(axisWB, axisWA, err);

  Vec3.sub(b.angularVelocity, a.angularVelocity, relV);
  Vec3.addScaled(relV, err, -BAUMGARTE_ANG * invDt, corr);

  const len = Vec3.len(corr);
  if (len < 1e-10) return;
  Vec3.scale(corr, 1 / len, tmp);

  const ea = a.invInertiaWorld.e, eb = b.invInertiaWorld.e;
  const ka = a.kinematic ? 0 : tmp.x * (ea[0] * tmp.x + ea[1] * tmp.y + ea[2] * tmp.z)
           + tmp.y * (ea[3] * tmp.x + ea[4] * tmp.y + ea[5] * tmp.z)
           + tmp.z * (ea[6] * tmp.x + ea[7] * tmp.y + ea[8] * tmp.z);
  const kb = b.kinematic ? 0 : tmp.x * (eb[0] * tmp.x + eb[1] * tmp.y + eb[2] * tmp.z)
           + tmp.y * (eb[3] * tmp.x + eb[4] * tmp.y + eb[5] * tmp.z)
           + tmp.z * (eb[6] * tmp.x + eb[7] * tmp.y + eb[8] * tmp.z);
  const k = ka + kb;
  if (k < 1e-12) return;

  const lambda = -len / k;
  Vec3.scale(tmp, lambda, imp);
  applyAngularImpulse(a, imp, -1);
  applyAngularImpulse(b, imp, +1);
}

export function solveConstraints(joints, dt, iterations = 8, muscles = null) {
  const invDt = 1 / dt;
  if (muscles) for (let m = 0; m < muscles.length; m++) muscles[m].beginSubstep();

  for (let iter = 0; iter < iterations; iter++) {
    // Muscles solved with the joints so motor impulses and joint corrections
    // converge together rather than fighting each other
    if (muscles) {
      for (let m = 0; m < muscles.length; m++) muscles[m].solveIteration(dt);
    }
    for (let i = 0; i < joints.length; i++) {
      const j = joints[i];
      if (j.broken) continue;
      solvePointConstraint(j, invDt);
      if (j.type === 'hinge') {
        solveAxisAlignment(j, invDt);
        solveHingeLimits(j, invDt);
      } else if (j.type === 'fixed') {
        solveFixedOrientation(j, invDt);
      }
    }
  }
}
