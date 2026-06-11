import { FluidSurface } from './FluidSurface.js';

// Finite-wing (3D) corrections for a group of strips forming one planform.
// Strip BET alone treats every section as part of an infinite wing — no
// induced downwash, no tip vortices — which makes long narrow wings
// unrealistically efficient. From the planform's real geometry:
//   AR  = span² / area
//   Cdi = Cl² / (π·e·AR)            (induced drag per strip)
//   a3D = a2D · AR / (AR + 2)       (downwash-reduced lift slope)
//   tip loss: lift fades toward the tips, F(s) = √(1 − s⁶) at spanwise
//   station s ∈ [0,1] (gentle: planform taper is already in the strip chords)
// `surfaces` spans BOTH sides of a mirrored wing; span/area are the full
// planform's. `stations` (optional, parallel array) give |spanwise| fraction.
// `carryover` > 1 credits low-AR surfaces mounted on a body (tail) with the
// effective-AR boost from body lift carryover.
export function applyPlanform(surfaces, { span, area, e = 0.85, stations = null, carryover = 1 }) {
  const AR = (span * span / Math.max(area, 1e-9)) * carryover;
  const k = 1 / (Math.PI * e * AR);
  const slope3D = AR / (AR + 2);
  for (let i = 0; i < surfaces.length; i++) {
    const s = surfaces[i];
    s.inducedDragK = k;
    let tip = 1;
    if (stations) {
      const st = Math.min(1, Math.abs(stations[i]));
      tip = Math.sqrt(Math.max(0, 1 - st ** 6));
    }
    s.clScale = slope3D * tip;
  }
  return AR;
}

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
