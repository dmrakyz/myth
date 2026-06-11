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
  // Tip loss REDISTRIBUTES lift toward the root — the planform's mean
  // downwash penalty is already in slope3D, so the spanwise factor is
  // normalized to an area-weighted mean of 1 (otherwise the 3D penalty is
  // double-counted and the whole wing under-lifts).
  let tipF = null;
  if (stations) {
    tipF = new Array(surfaces.length);
    let wSum = 0, fSum = 0;
    for (let i = 0; i < surfaces.length; i++) {
      const st = Math.min(1, Math.abs(stations[i]));
      tipF[i] = Math.sqrt(Math.max(0, 1 - st ** 6));
      const a = surfaces[i].chord * surfaces[i].span;
      wSum += a; fSum += a * tipF[i];
    }
    const mean = fSum / Math.max(wSum, 1e-9);
    for (let i = 0; i < surfaces.length; i++) tipF[i] /= mean;
  }
  for (let i = 0; i < surfaces.length; i++) {
    const s = surfaces[i];
    s.inducedDragK = k;
    s.clScale = slope3D * (tipF ? tipF[i] : 1);
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
