import { Vec3 } from '../math/Vec3.js';
import { Feather } from './Feather.js';
import { AirfoilData } from '../fluid/AirfoilData.js';

// A row of feathers along a wing bone. The bone is an elongated segment whose
// long axis runs along ±x (outboard). Each feather is a BET strip whose span
// axis is the rachis (the feather's long axis, pointing outboard and fanning
// backward toward the tip) with passive pitch rotation about it — the
// venetian-blind twist real primaries exhibit on the upstroke.
//
// Frame convention: both wings use strip frames with positive-x span so that
// cambered airfoil tables behave identically left and right; only feather
// POSITIONS are mirrored (spanSign). The rachis line direction is sign-free.
let nextArrayId = 1;

export class FeatherArray {
  constructor({
    name = 'feathers',
    segmentId,             // bone the feathers attach to
    count = 8,
    rootX = 0,             // first feather root along bone x (signed, local)
    spacing = 0.03,        // root spacing along the bone (unsigned)
    rootChord = 0.04,      // feather vane width at the innermost feather
    tipChord = 0.025,
    featherLength = 0.2,   // rachis length
    spanSign = 1,          // +1 right wing, -1 left wing (positions only)
    fanStart = 0.1,        // sweep-back of innermost feather (radians)
    fanEnd = 0.8,          // sweep-back of outermost feather (radians)
    airfoilId = 'flatplate',
    torsionalStiffness = 0.5,
    restTwist = 0,
  }) {
    this.id = `fa_${nextArrayId++}`;
    this.name = name;
    this.segmentId = segmentId;
    this.params = {
      count, rootX, spacing, rootChord, tipChord, featherLength,
      spanSign, fanStart, fanEnd, airfoilId, torsionalStiffness, restTwist,
    };
    this.feathers = [];
    this.rebuild();
  }

  rebuild() {
    const p = this.params;
    this.feathers.length = 0;
    const airfoil = AirfoilData.get(p.airfoilId);
    const sign = p.spanSign;

    for (let i = 0; i < p.count; i++) {
      const t = p.count > 1 ? i / (p.count - 1) : 0;
      const chord = p.rootChord + (p.tipChord - p.rootChord) * t;
      const fan = p.fanStart + (p.fanEnd - p.fanStart) * t;

      // Root walks outboard along the bone
      const rootXPos = sign * (Math.abs(p.rootX) + i * p.spacing);

      // Strip frame (same handedness both sides):
      //   spanDir  = (cos f, 0, sign·sin f) — rachis line
      //   chordDir = (−sign·sin f, 0, cos f) — across the vane, toward TE
      const cf = Math.cos(fan), sf = Math.sin(fan);
      const spanDir = new Vec3(cf, 0, sign * sf);
      const chordDir = new Vec3(-sign * sf, 0, cf);

      // Vane center: from root, halfway along the actual outboard direction
      const vaneX = sign * cf, vaneZ = sf;
      const bodyPoint = new Vec3(
        rootXPos + vaneX * p.featherLength * 0.5,
        0,
        vaneZ * p.featherLength * 0.5,
      );

      this.feathers.push(new Feather({
        bodyPoint, chordDir, spanDir,
        chord, span: p.featherLength,
        airfoil,
        restTwist: p.restTwist,
        torsionalStiffness: p.torsionalStiffness * (0.6 + 0.8 * (1 - t)), // tips softer
        torsionalDamping: 0.05,
      }));
    }
  }

  computeForces(parentBody, medium, dt) {
    let total = 0;
    for (let i = 0; i < this.feathers.length; i++) {
      total += this.feathers[i].computeForce(parentBody, medium, dt);
    }
    return total;
  }
}
