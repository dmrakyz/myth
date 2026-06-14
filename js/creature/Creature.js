import { Vec3 } from '../math/Vec3.js';

// Assembled creature: a flat composition of segments (rigid bodies), joints,
// muscles, wings (BET strip groups), feather arrays, and membranes. The
// builder edits this structure directly; the simulator runs it directly.
const centroid = new Vec3();

export class Creature {
  constructor(name = 'creature') {
    this.name = name;
    this.segments = new Map();       // id → Segment
    this.joints = new Map();         // id → Joint  (+ jointMeta for serialization)
    this.muscles = new Map();        // id → Muscle
    this.wings = new Map();          // id → Wing (BET strips on a segment)
    this.featherArrays = new Map();  // id → FeatherArray
    this.membranes = new Map();      // id → WingMembrane
    this.rootSegmentId = null;
    this.flappingController = null;
    this.jointMeta = new Map();      // id → { segA, segB } for serialization
    this.muscleMeta = new Map();     // id → { jointId, pattern }
  }

  addSegment(segment, isRoot = false) {
    this.segments.set(segment.id, segment);
    if (isRoot || !this.rootSegmentId) this.rootSegmentId = segment.id;
    return segment;
  }

  addJoint(id, joint, segAId, segBId) {
    this.joints.set(id, joint);
    this.jointMeta.set(id, { segA: segAId, segB: segBId });
    return joint;
  }

  addMuscle(id, muscle, jointId) {
    this.muscles.set(id, muscle);
    this.muscleMeta.set(id, { jointId });
    return muscle;
  }

  addWing(wing) { this.wings.set(wing.id, wing); return wing; }
  addFeatherArray(fa) { this.featherArrays.set(fa.id, fa); return fa; }
  addMembrane(m) { this.membranes.set(m.id, m); return m; }

  get root() { return this.segments.get(this.rootSegmentId); }

  getRigidBodies() {
    const out = [];
    for (const s of this.segments.values()) out.push(s.rigidBody);
    return out;
  }

  getJointArray() {
    return [...this.joints.values()];
  }

  getCentroid(out = centroid) {
    let mx = 0, my = 0, mz = 0, mTot = 0;
    for (const s of this.segments.values()) {
      const m = s.rigidBody.mass;
      mx += s.rigidBody.position.x * m;
      my += s.rigidBody.position.y * m;
      mz += s.rigidBody.position.z * m;
      mTot += m;
    }
    if (mTot > 0) out.set(mx / mTot, my / mTot, mz / mTot);
    return out;
  }

  totalMass() {
    let m = 0;
    for (const s of this.segments.values()) m += s.rigidBody.mass;
    return m;
  }

  // Average velocity of the root segment (HUD airspeed)
  getVelocity() { return this.root ? this.root.rigidBody.velocity : null; }

  // Teleport the whole creature so the centroid lands at target, zeroing momenta
  placeAt(x, y, z, keepVelocity = false) {
    this.getCentroid(centroid);
    const dx = x - centroid.x, dy = y - centroid.y, dz = z - centroid.z;
    for (const s of this.segments.values()) {
      const rb = s.rigidBody;
      rb.position.x += dx; rb.position.y += dy; rb.position.z += dz;
      if (!keepVelocity) {
        rb.linMomentum.set(0, 0, 0);
        rb.angMomentum.set(0, 0, 0);
      }
      rb.updateDerived();
      rb.snapshotPrev();
    }
  }

  // Give the whole creature an initial velocity (launch)
  setVelocity(vx, vy, vz) {
    for (const s of this.segments.values()) {
      const rb = s.rigidBody;
      rb.linMomentum.set(vx * rb.mass, vy * rb.mass, vz * rb.mass);
      rb.updateDerived();
    }
    // Carry membrane cloth along too, or its pins snap on the first frame.
    for (const m of this.membranes.values()) m.setUniformVelocity(vx, vy, vz);
  }

  findSegmentByName(name) {
    for (const s of this.segments.values()) if (s.name === name) return s;
    return null;
  }
}
