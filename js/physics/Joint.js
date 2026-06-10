import { Vec3 } from '../math/Vec3.js';

// Joint between two rigid bodies. Types:
//   'ball'  — positional constraint only (3 DOF rotation free)
//   'hinge' — positional + axis alignment (1 DOF rotation about axisA)
//   'fixed' — positional + full orientation lock
//
// pivotA/pivotB are anchors in each body's local frame.
// axisA/axisB are the hinge axes in each body's local frame.
export class Joint {
  constructor({
    bodyA, bodyB,
    pivotA = new Vec3(), pivotB = new Vec3(),
    type = 'ball',
    axisA = new Vec3(1, 0, 0), axisB = new Vec3(1, 0, 0),
    limits = null,            // { min, max } radians about hinge axis
    breakForce = Infinity,
  }) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.pivotA = pivotA.clone();
    this.pivotB = pivotB.clone();
    this.type = type;
    this.axisA = axisA.clone();
    this.axisB = axisB.clone();
    this.limits = limits;
    this.breakForce = breakForce;
    this.broken = false;

    // Reference axes perpendicular to the hinge axis, used to measure joint
    // angle. Built lazily from axisA.
    this._refA = new Vec3();
    this._refB = new Vec3();
    this._buildReferenceFrame();

    // Scratch
    this._wA = new Vec3(); this._wB = new Vec3();
    this._t1 = new Vec3(); this._t2 = new Vec3(); this._t3 = new Vec3();
  }

  _buildReferenceFrame() {
    // Any vector perpendicular to axisA
    const a = this.axisA;
    if (Math.abs(a.x) < 0.9) this._refA.set(1, 0, 0);
    else this._refA.set(0, 1, 0);
    // refA ⟂ axisA via Gram-Schmidt
    const d = Vec3.dot(this._refA, a);
    Vec3.addScaled(this._refA, a, -d, this._refA);
    Vec3.norm(this._refA, this._refA);
    this._refB.copy(this._refA);
  }

  worldPivotA(out) { return this.bodyA.localToWorld(this.pivotA, out); }
  worldPivotB(out) { return this.bodyB.localToWorld(this.pivotB, out); }

  // Current hinge angle: rotation of bodyB's reference vector about the hinge
  // axis relative to bodyA's reference vector.
  getHingeAngle() {
    const axisW = this._t1, refAW = this._t2, refBW = this._t3;
    this.bodyA.localDirToWorld(this.axisA, axisW);
    this.bodyA.localDirToWorld(this._refA, refAW);
    this.bodyB.localDirToWorld(this._refB, refBW);
    // Project refBW into plane ⟂ axis
    const d = Vec3.dot(refBW, axisW);
    Vec3.addScaled(refBW, axisW, -d, refBW);
    Vec3.norm(refBW, refBW);
    const cos = Vec3.dot(refAW, refBW);
    const crossV = this._wA;
    Vec3.cross(refAW, refBW, crossV);
    const sin = Vec3.dot(crossV, axisW);
    return Math.atan2(sin, cos);
  }
}
