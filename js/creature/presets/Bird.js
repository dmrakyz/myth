import { Vec3 } from '../../math/Vec3.js';
import { Creature } from '../Creature.js';
import { Segment } from '../Segment.js';
import { Joint } from '../../physics/Joint.js';
import { Muscle } from '../../physics/Muscle.js';
import { Wing } from '../../fluid/Wing.js';
import { FluidSurface } from '../../fluid/FluidSurface.js';
import { FeatherArray } from '../FeatherArray.js';
import { AirfoilData } from '../../fluid/AirfoilData.js';
import { FlappingController } from '../FlappingController.js';

// Gull-scale bird, ~0.42 kg, ~1.1 m span.
// Frame: forward = −z, up = +y, right = +x. All segments rest at identity
// orientation; wing bones are elongated ellipsoids along ±x.
//
// Each wing: inner bone (arm, cambered secondaries as BET strips) + outer
// bone (hand, individual primary feathers with passive rachis pitch).
// Flapping: shoulder hinges about the body z axis driven by the controller;
// wrists follow with phase lag. Tail is an all-moving pitch surface.
export function createBird() {
  const c = new Creature('bird');
  const naca = AirfoilData.get('naca2412');

  // --- Torso ---
  const torso = new Segment({
    name: 'torso', shape: 'ellipsoid',
    dimensions: [0.05, 0.055, 0.13],
    mass: 0.30,
    position: new Vec3(0, 0, 0),
    aeroProfile: 'streamlined',
    color: 0x8a7a66,
  });
  c.addSegment(torso, true);

  // --- Head ---
  const head = new Segment({
    name: 'head', shape: 'ellipsoid',
    dimensions: [0.028, 0.028, 0.04],
    mass: 0.035,
    position: new Vec3(0, 0.035, -0.16),
    aeroProfile: 'streamlined',
    color: 0xd8d0c2,
  });
  c.addSegment(head);
  c.addJoint('neck', new Joint({
    bodyA: torso.rigidBody, bodyB: head.rigidBody,
    pivotA: new Vec3(0, 0.03, -0.12), pivotB: new Vec3(0, -0.005, 0.04),
    type: 'fixed',
    axisA: new Vec3(0, 0, 1), axisB: new Vec3(0, 0, 1),
  }), torso.id, head.id);

  // --- Tail (all-moving pitch surface) ---
  const tail = new Segment({
    name: 'tail', shape: 'plate',
    dimensions: [0.13, 0.16],          // chord, span
    mass: 0.012,
    position: new Vec3(0, 0, 0.20),
    aeroProfile: 'bluntbody',
    noBodyPanels: true,       // explicit tail strip below covers this surface
    color: 0x6e6253,
  });
  c.addSegment(tail);
  const tailJoint = c.addJoint('tailJoint', new Joint({
    bodyA: torso.rigidBody, bodyB: tail.rigidBody,
    pivotA: new Vec3(0, 0, 0.13), pivotB: new Vec3(0, 0, -0.07),
    type: 'hinge',
    axisA: new Vec3(1, 0, 0), axisB: new Vec3(1, 0, 0),
    limits: { min: -0.6, max: 0.6 },
  }), torso.id, tail.id);
  c.addMuscle('tailMuscle', new Muscle({
    joint: tailJoint, stiffness: 16, damping: 2.5, maxTorque: 1.5, restAngle: 0,
  }), 'tailJoint');
  c.addWing(new Wing({
    name: 'tailSurface', segmentId: tail.id,
    strips: [new FluidSurface({
      bodyPoint: new Vec3(0, 0, 0.01),
      chordDir: new Vec3(0, 0, 1), spanDir: new Vec3(1, 0, 0),
      chord: 0.13, span: 0.16,
      airfoil: AirfoilData.get('flatplate'),
    })],
  }));
  // Vertical fin equivalent: a splayed bird tail presents side area at
  // sideslip. Without a weathercock surface sideslip grows unchecked and
  // couples through wing dihedral into spiral divergence. The strip is also
  // the active rudder (tail twist) — registered with the controller below.
  const tailFinStrip = new FluidSurface({
    bodyPoint: new Vec3(0, 0.01, 0.20),
    chordDir: new Vec3(0, 0, 1), spanDir: new Vec3(0, 1, 0),
    chord: 0.14, span: 0.16,
    airfoil: AirfoilData.get('flatplate'),
  });
  c.addWing(new Wing({
    name: 'tailFin', segmentId: torso.id,
    strips: [tailFinStrip],
  }));

  // --- Wings (mirrored helper) ---
  const twistWiring = [];
  for (const side of [+1, -1]) {
    const sideName = side > 0 ? 'R' : 'L';

    // Inner bone (humerus+forearm): shoulder at x=±0.05 to wrist at ±0.24
    const inner = new Segment({
      name: `arm${sideName}`, shape: 'ellipsoid',
      dimensions: [0.095, 0.011, 0.022],
      mass: 0.022,
      position: new Vec3(side * 0.145, 0.02, -0.03),
      aeroProfile: 'bluntbody',
      noBodyPanels: true,    // fully covered by secondary wing strips
      color: 0x8a7a66,
    });
    c.addSegment(inner);

    // Outer bone (hand): wrist ±0.24 to tip ±0.42
    const outer = new Segment({
      name: `hand${sideName}`, shape: 'ellipsoid',
      dimensions: [0.09, 0.008, 0.018],
      mass: 0.013,
      position: new Vec3(side * 0.33, 0.02, -0.03),
      aeroProfile: 'bluntbody',
      noBodyPanels: true,    // fully covered by primary feather array
      color: 0x8a7a66,
    });
    c.addSegment(outer);

    // Shoulder hinge: flap axis = body fore-aft (z)
    const shoulder = c.addJoint(`shoulder${sideName}`, new Joint({
      bodyA: torso.rigidBody, bodyB: inner.rigidBody,
      pivotA: new Vec3(side * 0.05, 0.02, -0.03),
      pivotB: new Vec3(-side * 0.095, 0, 0),
      type: 'hinge',
      axisA: new Vec3(0, 0, 1), axisB: new Vec3(0, 0, 1),
      limits: { min: -1.2, max: 1.2 },
    }), torso.id, inner.id);
    c.addMuscle(`flap${sideName}`, new Muscle({
      joint: shoulder, stiffness: 35, damping: 1.1, maxTorque: 14, restAngle: 0,
    }), `shoulder${sideName}`);

    // Wrist hinge
    const wrist = c.addJoint(`wrist${sideName}`, new Joint({
      bodyA: inner.rigidBody, bodyB: outer.rigidBody,
      pivotA: new Vec3(side * 0.095, 0, 0),
      pivotB: new Vec3(-side * 0.09, 0, 0),
      type: 'hinge',
      axisA: new Vec3(0, 0, 1), axisB: new Vec3(0, 0, 1),
      limits: { min: -0.9, max: 0.9 },
    }), inner.id, outer.id);
    c.addMuscle(`wrist${sideName}`, new Muscle({
      joint: wrist, stiffness: 6, damping: 0.8, maxTorque: 3, restAngle: 0,
    }), `wrist${sideName}`);

    // Secondaries: cambered BET strips on the inner bone. Strip frames are
    // identical on both sides (positive-x span) so the cambered table is
    // symmetric; positions mirror via `side`.
    const innerStrips = [];
    for (let i = 0; i < 5; i++) {
      const x = side * (-0.075 + i * 0.0375);
      const chord = 0.115 - i * 0.007;
      const bodyPoint = new Vec3(x, 0, 0.0);
      innerStrips.push(new FluidSurface({
        bodyPoint,
        chordDir: new Vec3(0, 0, 1), spanDir: new Vec3(1, 0, 0),
        chord, span: 0.075,
        airfoil: naca,
        camberAngle: 0.12,             // ~7° positive incidence for glide lift
      }));
      // Secondaries + covert tissue mass carried by the arm bone
      inner.addAttachedMass(chord * 0.075 * 0.35, bodyPoint);
    }
    const innerWing = c.addWing(new Wing({
      name: `innerWing${sideName}`, segmentId: inner.id, strips: innerStrips,
    }));

    // Tertials: the strip between wing root and body, carried by the torso.
    // Fills the lift gap at the root (real birds have no slot there) and puts
    // a bit of area at the CG, which steadies roll without adding moment arm.
    c.addWing(new Wing({
      name: `tertials${sideName}`, segmentId: torso.id,
      strips: [new FluidSurface({
        bodyPoint: new Vec3(side * 0.045, 0.025, -0.02),
        chordDir: new Vec3(0, 0, 1), spanDir: new Vec3(1, 0, 0),
        chord: 0.115, span: 0.05,
        airfoil: naca,
        camberAngle: 0.12,
      })],
    }));

    // Alula (bastard wing): small high-AoA device at the wrist's leading
    // edge. A flat plate keeps generating force past the main wing's stall,
    // softening stall onset during the high-α phases of a flap cycle.
    c.addWing(new Wing({
      name: `alula${sideName}`, segmentId: outer.id,
      strips: [new FluidSurface({
        bodyPoint: new Vec3(side * -0.055, 0.004, -0.035),
        chordDir: new Vec3(0, 0, 1), spanDir: new Vec3(1, 0, 0),
        chord: 0.035, span: 0.05,
        airfoil: AirfoilData.get('flatplate'),
        camberAngle: 0.10,
      })],
    }));


    // Primaries: individual feathers on the hand bone
    const primaries = new FeatherArray({
      name: `primaries${sideName}`,
      segmentId: outer.id,
      count: 9,
      rootX: -0.075,
      spacing: 0.021,
      rootChord: 0.05, tipChord: 0.028,
      featherLength: 0.20,
      spanSign: side,
      fanStart: 0.06, fanEnd: 0.55,
      airfoilId: 'flatplate',
      torsionalStiffness: 0.35,
    });
    c.addFeatherArray(primaries);
    // Feather mass loads the hand bone's inertia tensor (a real bird's hand
    // wing inertia is dominated by its primaries)
    for (const feather of primaries.feathers) {
      const fMass = feather.surface.chord * feather.surface.span * 0.08;
      outer.addAttachedMass(fMass, feather.surface.bodyPoint);
    }

    // Active twist (pronation/supination) wired up after the controller exists
    twistWiring.push(innerWing, primaries);
  }

  // --- Flapping controller ---
  const ctrl = new FlappingController(c);
  // Medium/large-bird wingbeat: strong and slow (~3 Hz at full power, like a
  // gull or crow). Low frequency + larger amplitude reads as a real flap and
  // lets the overdamped muscle reach a wide stroke instead of a fast buzz.
  const FLAP_FREQ = 3.0;
  // Hinge sign convention: +rotation about z lifts the RIGHT wing and lowers
  // the LEFT, so the left pattern is amplitude-negated for symmetric flapping.
  // Amplitude 0.7 rad commands an ~80° stroke envelope — the stiffer shoulder
  // muscle tracks most of it, landing in a gull's 60–90° stroke range.
  // restAngle 0.22 sets a visible dihedral: the stroke rides above level, and
  // the upward-vee makes roll passively self-righting — without it a slow
  // launch can roll the bird all the way over before the reflex catches it.
  // stabRoll on the shoulders: a common-sign offset raises one wing root and
  // lowers the other (hinges mirror), shifting the lift vector — far more roll
  // torque than the wrist fold alone, which saturates in a big departure.
  ctrl.setPattern('flapR', {
    frequency: FLAP_FREQ, amplitude: 0.7, phase: 0, restAngle: 0.22,
    waveform: 'downbeat', stabRoll: -0.25,
  });
  ctrl.setPattern('flapL', {
    frequency: FLAP_FREQ, amplitude: -0.7, phase: 0, restAngle: -0.22,
    waveform: 'downbeat', stabRoll: -0.25,
  });
  // Wrists ride the same cycle as the shoulders ('foldup' is keyed to the
  // downbeat phases): a slight extension whip through the downstroke, then
  // the hand folds in through the upstroke to cut negative lift — real
  // recovery-stroke wing folding. Roll stabilization/steering also lives
  // here: a common-sign offset folds one hand while extending the other
  // (hinge conventions mirror), shifting lift spanwise — how birds bank.
  ctrl.setPattern('wristR', {
    frequency: FLAP_FREQ, amplitude: 0.35, phase: 0, restAngle: 0.05,
    waveform: 'foldup',
    stabRoll: -0.6,
  });
  ctrl.setPattern('wristL', {
    frequency: FLAP_FREQ, amplitude: -0.35, phase: 0, restAngle: -0.05,
    waveform: 'foldup',
    stabRoll: -0.6,
  });
  // Pronation/supination through the stroke (see FlappingController.twists).
  // Gentle servo: a hard AoA clamp over-relieves and dumps the lift the
  // downstroke is supposed to produce; max 0.25 rad ≈ a gull's measured twist.
  for (const w of twistWiring) ctrl.addWingTwist(w, { relax: 0.1, max: 0.25 });
  // Tail: pitch control surface. Negative hinge angle = TE up = downward tail force
  // aft of CG = nose-up moment. So all pitch signals must drive toward negative angles.
  ctrl.setPattern('tailMuscle', {
    frequency: 0, amplitude: 0, restAngle: -0.04,
    pitchBias: -0.4,
    flapScale: 0,
    stabPitch: -1.5,
  });
  // Active rudder (tail twist): yaw-rate damping + sideslip weathercock +
  // yaw-stick authority on the vertical fin strip.
  ctrl.setRudder(tailFinStrip, { yawGain: 0.5, slipGain: 0.04, cmdGain: 0.3, max: 0.4 });
  c.flappingController = ctrl;

  // --- Visual anatomy (beak, eyes, legs) ---
  // Purely visual decorations — no separate rigid bodies or joints to avoid
  // overloading the sequential-impulse solver with fixed joints on tiny masses.
  // Mass contributions are folded into the parent's inertia via addAttachedMass.
  head.addAttachedMass(0.003, new Vec3(0, -0.006, -0.065));      // beak
  head.addAttachedMass(0.001, new Vec3( 0.024, 0.003, -0.010));  // eyeR
  head.addAttachedMass(0.001, new Vec3(-0.024, 0.003, -0.010));  // eyeL
  torso.addAttachedMass(0.008, new Vec3( 0.028, -0.073, 0.015)); // legR
  torso.addAttachedMass(0.008, new Vec3(-0.028, -0.073, 0.015)); // legL

  c.visualAttachments = [
    { parentSegId: head.id,  localPos: new Vec3(0,       -0.006, -0.065), shape: 'ellipsoid', dimensions: [0.007, 0.006, 0.026], color: 0xd4a830 },
    { parentSegId: head.id,  localPos: new Vec3( 0.024,   0.003, -0.010), shape: 'ellipsoid', dimensions: [0.007, 0.007, 0.005], color: 0x181010 },
    { parentSegId: head.id,  localPos: new Vec3(-0.024,   0.003, -0.010), shape: 'ellipsoid', dimensions: [0.007, 0.007, 0.005], color: 0x181010 },
    { parentSegId: torso.id, localPos: new Vec3( 0.028,  -0.073, 0.015),  shape: 'ellipsoid', dimensions: [0.012, 0.025, 0.012], color: 0xd09040 },
    { parentSegId: torso.id, localPos: new Vec3(-0.028,  -0.073, 0.015),  shape: 'ellipsoid', dimensions: [0.012, 0.025, 0.012], color: 0xd09040 },
  ];

  return c;
}
