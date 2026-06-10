import { Vec3 } from '../math/Vec3.js';

// Particle cloth for membrane wings, solved with XPBD. Particles live in
// world space. Pin constraints glue boundary particles to points on rigid
// bodies (one-way: the skeleton drives the membrane). Stored as flat arrays
// for cache locality.
export class ClothBody {
  constructor(particleCount) {
    this.count = particleCount;
    this.pos = new Float64Array(particleCount * 3);
    this.prevPos = new Float64Array(particleCount * 3);
    this.vel = new Float64Array(particleCount * 3);
    this.invMass = new Float64Array(particleCount);
    this.extForce = new Float64Array(particleCount * 3); // aero forces, cleared each substep

    // Constraints
    this.distance = [];  // { i, j, rest, compliance }
    this.pins = [];      // { i, body, localPoint:Vec3 }

    this.gravity = 9.81;
  }

  setParticle(i, x, y, z, mass) {
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.prevPos[i * 3] = x; this.prevPos[i * 3 + 1] = y; this.prevPos[i * 3 + 2] = z;
    this.invMass[i] = mass > 0 ? 1 / mass : 0;
  }

  addDistanceConstraint(i, j, compliance = 1e-6) {
    const dx = this.pos[i * 3] - this.pos[j * 3];
    const dy = this.pos[i * 3 + 1] - this.pos[j * 3 + 1];
    const dz = this.pos[i * 3 + 2] - this.pos[j * 3 + 2];
    this.distance.push({ i, j, rest: Math.sqrt(dx * dx + dy * dy + dz * dz), compliance });
  }

  addPin(i, body, localPoint) {
    this.invMass[i] = 0;
    this.pins.push({ i, body, localPoint: localPoint.clone(), _w: new Vec3() });
  }

  addForce(i, fx, fy, fz) {
    this.extForce[i * 3] += fx;
    this.extForce[i * 3 + 1] += fy;
    this.extForce[i * 3 + 2] += fz;
  }

  getPos(i, out) {
    out.x = this.pos[i * 3]; out.y = this.pos[i * 3 + 1]; out.z = this.pos[i * 3 + 2];
    return out;
  }

  // Velocity of particle i (for aero force computation)
  getVel(i, out) {
    out.x = this.vel[i * 3]; out.y = this.vel[i * 3 + 1]; out.z = this.vel[i * 3 + 2];
    return out;
  }

  solve(dt, substeps = 4) {
    const h = dt / substeps;
    const n = this.count;
    const pos = this.pos, prev = this.prevPos, vel = this.vel;
    const invMass = this.invMass, ext = this.extForce;

    for (let step = 0; step < substeps; step++) {
      // Predict
      for (let i = 0; i < n; i++) {
        if (invMass[i] === 0) continue;
        const i3 = i * 3;
        prev[i3] = pos[i3]; prev[i3 + 1] = pos[i3 + 1]; prev[i3 + 2] = pos[i3 + 2];
        vel[i3 + 1] -= this.gravity * h;
        vel[i3] += ext[i3] * invMass[i] * h;
        vel[i3 + 1] += ext[i3 + 1] * invMass[i] * h;
        vel[i3 + 2] += ext[i3 + 2] * invMass[i] * h;
        pos[i3] += vel[i3] * h;
        pos[i3 + 1] += vel[i3 + 1] * h;
        pos[i3 + 2] += vel[i3 + 2] * h;
      }

      // Pins: snap to current rigid body anchor positions
      for (let p = 0; p < this.pins.length; p++) {
        const pin = this.pins[p];
        pin.body.localToWorld(pin.localPoint, pin._w);
        const i3 = pin.i * 3;
        pos[i3] = pin._w.x; pos[i3 + 1] = pin._w.y; pos[i3 + 2] = pin._w.z;
      }

      // Distance constraints (XPBD)
      const h2 = h * h;
      for (let c = 0; c < this.distance.length; c++) {
        const con = this.distance[c];
        const i3 = con.i * 3, j3 = con.j * 3;
        const w1 = invMass[con.i], w2 = invMass[con.j];
        const wSum = w1 + w2;
        if (wSum === 0) continue;
        let dx = pos[i3] - pos[j3];
        let dy = pos[i3 + 1] - pos[j3 + 1];
        let dz = pos[i3 + 2] - pos[j3 + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-9) continue;
        const C = len - con.rest;
        const alpha = con.compliance / h2;
        const dLambda = -C / (wSum + alpha);
        const s = dLambda / len;
        dx *= s; dy *= s; dz *= s;
        pos[i3] += dx * w1; pos[i3 + 1] += dy * w1; pos[i3 + 2] += dz * w1;
        pos[j3] -= dx * w2; pos[j3 + 1] -= dy * w2; pos[j3 + 2] -= dz * w2;
      }

      // Velocity update
      const invH = 1 / h;
      for (let i = 0; i < n; i++) {
        if (invMass[i] === 0) continue;
        const i3 = i * 3;
        vel[i3] = (pos[i3] - prev[i3]) * invH;
        vel[i3 + 1] = (pos[i3 + 1] - prev[i3 + 1]) * invH;
        vel[i3 + 2] = (pos[i3 + 2] - prev[i3 + 2]) * invH;
        // Mild velocity damping for stability
        vel[i3] *= 0.999; vel[i3 + 1] *= 0.999; vel[i3 + 2] *= 0.999;
      }
    }

    this.extForce.fill(0);
  }
}
