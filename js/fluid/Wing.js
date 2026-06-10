import { FluidSurface } from './FluidSurface.js';

// A named group of BET strips attached to one parent segment (a wing bone,
// fin base, or the torso itself). Used for wings, fins, and tail surfaces.
let nextWingId = 1;

export class Wing {
  constructor({ name = 'wing', segmentId, strips = [] }) {
    this.id = `wing_${nextWingId++}`;
    this.name = name;
    this.segmentId = segmentId;
    this.strips = strips;   // FluidSurface[]
    this.lastTotalLift = 0; // telemetry
  }

  computeForces(parentBody, medium, dt) {
    let total = 0;
    for (let i = 0; i < this.strips.length; i++) {
      total += this.strips[i].computeForce(parentBody, medium, dt);
    }
    this.lastTotalLift = total;
    return total;
  }
}
