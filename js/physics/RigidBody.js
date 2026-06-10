import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';
import { Mat3 } from '../math/Mat3.js';

// 6DOF rigid body. State vector layout (Float64Array[13]):
//   [0..2]   position (world)
//   [3..6]   orientation quaternion (w, x, y, z)
//   [7..9]   linear momentum
//   [10..12] angular momentum (world frame)
//
// Forces/torques accumulate between derivative evaluations; the RK4 driver
// treats them as constant over the substep (forces are recomputed every
// substep at 240 Hz, which is accurate enough for these dynamics).

let nextBodyId = 1;

export class RigidBody {
  constructor({ mass = 1, position = null, orientation = null } = {}) {
    this.id = nextBodyId++;
    this.mass = mass;
    this.invMass = mass > 0 ? 1 / mass : 0;

    this.position = new Vec3();
    if (position) this.position.copy(position);
    this.orientation = new Quat();
    if (orientation) this.orientation.copy(orientation);

    this.linMomentum = new Vec3();
    this.angMomentum = new Vec3();

    // Derived state, refreshed by updateDerived()
    this.velocity = new Vec3();
    this.angularVelocity = new Vec3();
    this.rotation = new Mat3();        // from orientation
    this.invInertiaBody = new Mat3();
    this.invInertiaWorld = new Mat3();

    // Previous-state cache for render interpolation
    this.prevPosition = new Vec3();
    this.prevOrientation = new Quat();

    this.forceAccum = new Vec3();
    this.torqueAccum = new Vec3();

    this.kinematic = false; // kinematic bodies ignore forces (builder mode anchor)

    this._tmpM = new Mat3();
    this._tmpV = new Vec3();
  }

  setMass(mass) {
    this.mass = mass;
    this.invMass = mass > 0 ? 1 / mass : 0;
  }

  setInertia(inertiaBody) {
    Mat3.invert(inertiaBody, this.invInertiaBody);
  }

  updateDerived() {
    Vec3.scale(this.linMomentum, this.invMass, this.velocity);
    Quat.toMat3(this.orientation, this.rotation);
    Mat3.similarity(this.rotation, this.invInertiaBody, this.invInertiaWorld, this._tmpM);
    Mat3.mulVec(this.invInertiaWorld, this.angMomentum, this.angularVelocity);
  }

  snapshotPrev() {
    this.prevPosition.copy(this.position);
    this.prevOrientation.copy(this.orientation);
  }

  localToWorld(localPoint, out) {
    Quat.rotateVec(this.orientation, localPoint, out);
    return Vec3.add(out, this.position, out);
  }

  localDirToWorld(localDir, out) {
    return Quat.rotateVec(this.orientation, localDir, out);
  }

  worldToLocal(worldPoint, out) {
    Vec3.sub(worldPoint, this.position, out);
    return Quat.rotateVecInv(this.orientation, out, out);
  }

  // Velocity of a world-space point attached to this body: v + ω × r
  pointVelocity(worldPoint, out) {
    Vec3.sub(worldPoint, this.position, this._tmpV);
    Vec3.cross(this.angularVelocity, this._tmpV, out);
    return Vec3.add(out, this.velocity, out);
  }

  applyForce(force, worldPoint) {
    Vec3.add(this.forceAccum, force, this.forceAccum);
    Vec3.sub(worldPoint, this.position, this._tmpV);
    const tx = this._tmpV.y * force.z - this._tmpV.z * force.y;
    const ty = this._tmpV.z * force.x - this._tmpV.x * force.z;
    const tz = this._tmpV.x * force.y - this._tmpV.y * force.x;
    this.torqueAccum.x += tx;
    this.torqueAccum.y += ty;
    this.torqueAccum.z += tz;
  }

  applyCentralForce(force) {
    Vec3.add(this.forceAccum, force, this.forceAccum);
  }

  applyTorque(torque) {
    Vec3.add(this.torqueAccum, torque, this.torqueAccum);
  }

  applyImpulse(impulse, worldPoint) {
    if (this.kinematic) return;
    Vec3.add(this.linMomentum, impulse, this.linMomentum);
    Vec3.sub(worldPoint, this.position, this._tmpV);
    this.angMomentum.x += this._tmpV.y * impulse.z - this._tmpV.z * impulse.y;
    this.angMomentum.y += this._tmpV.z * impulse.x - this._tmpV.x * impulse.z;
    this.angMomentum.z += this._tmpV.x * impulse.y - this._tmpV.y * impulse.x;
    this.updateDerived();
  }

  clearAccumulators() {
    Vec3.zero(this.forceAccum);
    Vec3.zero(this.torqueAccum);
  }

  getState(s) {
    s[0] = this.position.x; s[1] = this.position.y; s[2] = this.position.z;
    s[3] = this.orientation.w; s[4] = this.orientation.x; s[5] = this.orientation.y; s[6] = this.orientation.z;
    s[7] = this.linMomentum.x; s[8] = this.linMomentum.y; s[9] = this.linMomentum.z;
    s[10] = this.angMomentum.x; s[11] = this.angMomentum.y; s[12] = this.angMomentum.z;
  }

  setState(s) {
    this.position.set(s[0], s[1], s[2]);
    this.orientation.set(s[3], s[4], s[5], s[6]);
    Quat.normalize(this.orientation, this.orientation);
    this.linMomentum.set(s[7], s[8], s[9]);
    this.angMomentum.set(s[10], s[11], s[12]);
    this.updateDerived();
  }

  // ṡ = f(s). Forces/torques held constant; ω recomputed from the stage state
  // because I_world_inv depends on the stage orientation.
  computeDerivative(s, ds) {
    const invMass = this.invMass;
    // ẋ = v = p/m
    ds[0] = s[7] * invMass;
    ds[1] = s[8] * invMass;
    ds[2] = s[9] * invMass;

    // ω from stage orientation: R(q) * I_body_inv * R(q)ᵀ * L
    const qw = s[3], qx = s[4], qy = s[5], qz = s[6];
    const ql = Math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz) || 1;
    const nw = qw / ql, nx = qx / ql, ny = qy / ql, nz = qz / ql;

    const sq = this._stageQuat || (this._stageQuat = { w: 1, x: 0, y: 0, z: 0 });
    sq.w = nw; sq.x = nx; sq.y = ny; sq.z = nz;
    const R = this._stageR || (this._stageR = new Mat3());
    Quat.toMat3(sq, R);
    const Iinv = this._stageIinv || (this._stageIinv = new Mat3());
    Mat3.similarity(R, this.invInertiaBody, Iinv, this._tmpM);

    const Lx = s[10], Ly = s[11], Lz = s[12];
    const e = Iinv.e;
    const ox = e[0] * Lx + e[1] * Ly + e[2] * Lz;
    const oy = e[3] * Lx + e[4] * Ly + e[5] * Lz;
    const oz = e[6] * Lx + e[7] * Ly + e[8] * Lz;

    // q̇ = 0.5 * [0, ω] * q
    ds[3] = 0.5 * (-ox * nx - oy * ny - oz * nz);
    ds[4] = 0.5 * ( ox * nw + oy * nz - oz * ny);
    ds[5] = 0.5 * (-ox * nz + oy * nw + oz * nx);
    ds[6] = 0.5 * ( ox * ny - oy * nx + oz * nw);

    // ṗ = F, L̇ = τ
    ds[7] = this.forceAccum.x;
    ds[8] = this.forceAccum.y;
    ds[9] = this.forceAccum.z;
    ds[10] = this.torqueAccum.x;
    ds[11] = this.torqueAccum.y;
    ds[12] = this.torqueAccum.z;
  }
}
