import { Vec3 } from '../math/Vec3.js';
import { Feather } from './Feather.js';
import { AirfoilData } from '../fluid/AirfoilData.js';

// A row of feathers attached along one wing bone. Primaries (outboard) get
// individual passive-pitch physics; the fan-out angle spreads them like a
// real primary fan so tip slots open under load.
//
// Bone convention: bone capsule extends along its local z axis; feathers
// sprout in local +spanSign·x and trail in local +z (chordwise back).
let nextArrayId = 1;

export class FeatherArray {
  constructor({
    name = 'feathers',
    segmentId,            // bone the feathers attach to
    count = 8,
    rootOffset = 0,       // start position along bone z (from bone center)
    spacing = 0.05,       // distance between feather roots along bone
    rootChord = 0.12,
    tipChord = 0.06,
    featherSpan = 0.22,   // length of each feather vane
    spanSign = 1,         // +1 right wing, -1 left wing
    fanAngle = 0.5,       // total fan spread at the tip (radians)
    sweepBack = 0.25,     // backward sweep of outer feathers (radians)
    airfoilId = 'flatplate',
    torsionalStiffness = 0.5,
  }) {
    this.id = `fa_${nextArrayId++}`;
    this.name = name;
    this.segmentId = segmentId;
    this.params = {
      count, rootOffset, spacing, rootChord, tipChord, featherSpan,
      spanSign, fanAngle, sweepBack, airfoilId, torsionalStiffness,
    };
    this.feathers = [];
    this.rebuild();
  }

  rebuild() {
    const p = this.params;
    this.feathers.length = 0;
    const airfoil = AirfoilData.get(p.airfoilId);

    for (let i = 0; i < p.count; i++) {
      const t = p.count > 1 ? i / (p.count - 1) : 0;
      const chord = p.rootChord + (p.tipChord - p.rootChord) * t;
      // Outer feathers fan out backward and slightly down
      const fan = (t - 0.5) * p.fanAngle + t * p.sweepBack;

      const root = new Vec3(0, 0, -p.rootOffset + i * p.spacing);
      // Feather extends outboard, rotated back by fan angle in the xz plane
      const spanDir = new Vec3(
        p.spanSign * Math.cos(fan), 0, Math.sin(fan));
      const chordDir = new Vec3(
        -p.spanSign * Math.sin(fan), 0, Math.cos(fan));
      // Aerodynamic center: half the feather span outboard from the root
      const bodyPoint = new Vec3(
        root.x + spanDir.x * p.featherSpan * 0.5,
        root.y,
        root.z + spanDir.z * p.featherSpan * 0.5,
      );

      this.feathers.push(new Feather({
        bodyPoint, chordDir, spanDir,
        chord, span: p.featherSpan,
        airfoil,
        restTwist: 0,
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
