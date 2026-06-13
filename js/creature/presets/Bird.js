import { Vec3 } from '../../math/Vec3.js';
import { Creature } from '../Creature.js';
import { Segment } from '../Segment.js';
import { Joint } from '../../physics/Joint.js';
import { Muscle } from '../../physics/Muscle.js';
import { Wing, applyPlanform } from '../../fluid/Wing.js';
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
  // 0.20 kg torso → ~0.36 kg all-up (small-gull range). Lighter than the
  // original 0.30 because the wing must carry the full weight on BET alone:
  // with the flapBoost body-force gone, this wing loading is what lets powered
  // flight hold level instead of sinking.
  const torso = new Segment({
    name: 'torso', shape: 'ellipsoid',
    dimensions: [0.05, 0.055, 0.13],
    mass: 0.20,
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
  // maxTorque raised 2.5→3.5: the shoulder now produces up to 12 N·m of pitch
  // reaction; the tail needs more authority to damp it within one beat.
  c.addMuscle('tailMuscle', new Muscle({
    joint: tailJoint, stiffness: 22, damping: 3.0, maxTorque: 3.5, restAngle: 0,
  }), 'tailJoint');
  const tailSurfaceStrip = new FluidSurface({
    bodyPoint: new Vec3(0, 0, 0.01),
    chordDir: new Vec3(0, 0, 1), spanDir: new Vec3(1, 0, 0),
    chord: 0.13, span: 0.16,
    airfoil: AirfoilData.get('flatplate'),
  });
  c.addWing(new Wing({
    name: 'tailSurface', segmentId: tail.id,
    strips: [tailSurfaceStrip],
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
  // Main-wing planform accumulator: every lifting surface of the wing pair
  // plus its spanwise center, for the finite-wing (3D) corrections below.
  const wingSurfs = [], wingCx = [];
  // Wake-capture source strips, collected per side for controller wiring below.
  const wakeStripsR = [], wakeStripsL = [];
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

    // Shoulder hinge: flap axis = body fore-aft (z). High muscle damping
    // (below) models the viscoelastic shoulder, absorbing the wingbeat
    // reaction so flapping doesn't force a pitch limit cycle on the torso.
    const shoulder = c.addJoint(`shoulder${sideName}`, new Joint({
      bodyA: torso.rigidBody, bodyB: inner.rigidBody,
      pivotA: new Vec3(side * 0.05, 0.02, -0.03),
      pivotB: new Vec3(-side * 0.095, 0, 0),
      type: 'hinge',
      axisA: new Vec3(0, 0, 1), axisB: new Vec3(0, 0, 1),
      limits: { min: -1.2, max: 1.2 },
    }), torso.id, inner.id);
    // Pectoralis muscle: maxTorque 12 N·m, damping 1.5. Lower damping lets the
    // shoulder actually complete its stroke (terminal velocity = maxTorque/c =
    // 8 rad/s, ~1 rad per half-stroke at 3.8 Hz). The pitch reaction torque is
    // handled by the tail stabPitch (-2.2) + AoA stabilizer, not shoulder damping.
    c.addMuscle(`flap${sideName}`, new Muscle({
      joint: shoulder, stiffness: 40, damping: 1.5, maxTorque: 12, restAngle: 0,
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
      joint: wrist, stiffness: 8, damping: 0.8, maxTorque: 4, restAngle: 0,
    }), `wrist${sideName}`);

    // Secondaries: cambered BET strips on the inner bone. Strip frames are
    // identical on both sides (positive-x span) so the cambered table is
    // symmetric; positions mirror via `side`.
    const innerStrips = [];
    for (let i = 0; i < 5; i++) {
      const x = side * (-0.075 + i * 0.0375);
      const chord = 0.14 - i * 0.008;
      const bodyPoint = new Vec3(x, 0, 0.0);
      innerStrips.push(new FluidSurface({
        bodyPoint,
        chordDir: new Vec3(0, 0, 1), spanDir: new Vec3(1, 0, 0),
        chord, span: 0.09,
        airfoil: naca,
        camberAngle: 0.12,             // ~7° positive incidence for glide lift
      }));
      // Secondaries + covert tissue mass carried by the arm bone
      inner.addAttachedMass(chord * 0.075 * 0.35, bodyPoint);
      wingSurfs.push(innerStrips[i]);
      wingCx.push(Math.abs(side * 0.145 + bodyPoint.x));
    }
    const innerWing = c.addWing(new Wing({
      name: `innerWing${sideName}`, segmentId: inner.id, strips: innerStrips,
    }));
    // Collect secondary strips for wake-capture injection
    const wakeTarget = side > 0 ? wakeStripsR : wakeStripsL;
    for (const s of innerStrips) wakeTarget.push(s);

    // Tertials: the strip between wing root and body, carried by the torso.
    // Fills the lift gap at the root (real birds have no slot there) and puts
    // a bit of area at the CG, which steadies roll without adding moment arm.
    const tertialStrip = new FluidSurface({
      bodyPoint: new Vec3(side * 0.045, 0.025, -0.02),
      chordDir: new Vec3(0, 0, 1), spanDir: new Vec3(1, 0, 0),
      chord: 0.115, span: 0.05,
      airfoil: naca,
      camberAngle: 0.12,
    });
    c.addWing(new Wing({
      name: `tertials${sideName}`, segmentId: torso.id,
      strips: [tertialStrip],
    }));
    wingSurfs.push(tertialStrip);
    wingCx.push(0.045);

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
      count: 11,
      rootX: -0.075,
      spacing: 0.017,
      rootChord: 0.042, tipChord: 0.024,
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
      wingSurfs.push(feather.surface);
      wingCx.push(Math.abs(side * 0.33 + feather.surface.bodyPoint.x));
    }

    // Active twist (pronation/supination) wired up after the controller exists
    twistWiring.push(innerWing, primaries);
  }

  // --- Finite-wing (3D) corrections ---
  // The full wing-pair planform sets induced drag and the downwash-reduced
  // lift slope on every main-wing strip; tips additionally lose lift to the
  // tip vortices. Tail surfaces are low-AR but ride the body's carryover
  // lift, credited via the carryover factor.
  {
    let area = 0, halfSpan = 0;
    for (let i = 0; i < wingSurfs.length; i++) {
      const s = wingSurfs[i];
      area += s.chord * s.span;
      halfSpan = Math.max(halfSpan, wingCx[i] + 0.5 * s.span * Math.abs(s.spanDir.x));
    }
    const stations = wingCx.map(cx => cx / halfSpan);
    applyPlanform(wingSurfs, { span: 2 * halfSpan, area, stations });
    // Unsteady-lift augmentation on the wing strips: flapping force comes
    // from the strips' real plunge kinematics (LEV/rotational/added-mass
    // boost in FluidSurface), not from an artificial body force. Sized so the
    // cycle-averaged lift reaches the bird's weight at the trimmed wingbeat.
    for (const s of wingSurfs) s.unsteadyGain = 2.0;
    applyPlanform([tailSurfaceStrip], { span: 0.16, area: 0.13 * 0.16, carryover: 1.6 });
    applyPlanform([tailFinStrip], { span: 0.16, area: 0.14 * 0.16, carryover: 1.6 });
  }

  // --- Flapping controller ---
  const ctrl = new FlappingController(c);
  // Crow/gull-scale wingbeat. 3.8 Hz at full power: enough cycle-averaged
  // thrust to nearly sustain level powered flight on BET alone (the bird is
  // power-limited for positive climb — that headroom comes later from active
  // camber, not a faster buzz). Larger amplitude reads as a real flap and lets
  // the overdamped muscle reach a wide stroke.
  const FLAP_FREQ = 3.8;
  // Hinge sign convention: +rotation about z lifts the RIGHT wing and lowers
  // the LEFT, so the left pattern is amplitude-negated for symmetric flapping.
  // Amplitude 1.5 rad commands a large stroke envelope — the deeper stroke is
  // what lets the wing carry the bird's weight on BET alone (no body-force
  // assist); the overdamped shoulder tracks most of it into a gull-like beat.
  // restAngle 0.22 sets a visible dihedral: the stroke rides above level, and
  // the upward-vee makes roll passively self-righting — without it a slow
  // launch can roll the bird all the way over before the reflex catches it.
  // stabRoll on the shoulders: a common-sign offset raises one wing root and
  // lowers the other (hinges mirror), shifting the lift vector — far more roll
  // torque than the wrist fold alone, which saturates in a big departure.
  // restAngle 0.30 sets the ARM dihedral. Combined with the drooped hand
  // (wrist restAngle ∓0.6 below) this is the gull's arched wing: humerus
  // angled up ~17°, hand drooping down. Crucially the net effective dihedral
  // is slightly POSITIVE, which makes the airframe PASSIVELY ROLL-STABLE
  // (measured: drooped hand alone diverges to inversion in 5 s with the
  // stabilizer off; arm dihedral 0.30 holds it to rollRMS 1°). The drooped
  // hand alone read as an unstable U; arching the arm over it gives both the
  // silhouette and the stability, so the active reflex stays gentle.
  // Amplitude 1.1 rad commanded → ~0.75 rad actual per half-stroke at terminal
  // velocity (maxTorque/c = 8 rad/s, half-period 0.13 s) → ~85° total arc,
  // matching a real gull (70–80°). Previous 1.5 produced 115° — too large.
  ctrl.setPattern('flapR', {
    frequency: FLAP_FREQ, amplitude: 1.1, phase: 0, restAngle: 0.30,
    waveform: 'downbeat', stabRoll: -0.40, tuckAngle: 0.30, brakeAngle: 0.35,
  });
  ctrl.setPattern('flapL', {
    frequency: FLAP_FREQ, amplitude: -1.1, phase: 0, restAngle: -0.30,
    waveform: 'downbeat', stabRoll: -0.40, tuckAngle: -0.30, brakeAngle: -0.35,
  });
  // Wrists: extend flat on the downstroke, fold on the upstroke — real bird
  // kinematics. 'upwhip' is a bell-shaped positive pulse locked to the power
  // stroke (t < 0.4 in the downbeat cycle): the wrist pivots from its folded
  // restAngle toward neutral (flat), maximising wing area for the BET strips
  // through the whole downstroke. On the upstroke the waveform returns to zero
  // and the spring pulls the hand back to the folded restAngle, shortening the
  // wing on recovery to cut negative lift.
  // restAngle ∓0.6: gull's arched wing — hand drooped below arm. Combined with
  // arm dihedral 0.30 (above) this gives net positive effective dihedral.
  // amplitude ±0.50 puts the peak target at -0.10/+0.10 rad (nearly flat) on
  // the downstroke — close to the ∓0.90 limit on extension, good headroom.
  // stabRoll −0.32 gives roll/bank authority via asymmetric wrist extension.
  ctrl.setPattern('wristR', {
    frequency: FLAP_FREQ, amplitude: 0.50, phase: 0, restAngle: -0.6,
    waveform: 'upwhip',
    stabRoll: -0.32, tuckAngle: -0.85,
  });
  ctrl.setPattern('wristL', {
    frequency: FLAP_FREQ, amplitude: -0.50, phase: 0, restAngle: 0.6,
    waveform: 'upwhip',
    stabRoll: -0.32, tuckAngle: 0.85,
  });
  // Pronation/supination through the stroke (see FlappingController.twists).
  // Big-stroke flapping demands big twist: the hand sections see the wind
  // tilt 30-45 deg at mid-downstroke, so the servo gets gull-scale authority
  // (0.6 rad), fast tracking (relax 0.7), and a positive AoA hold band
  // (aHold) so the upstroke carries weight instead of pushing down.
  for (const w of twistWiring) ctrl.addWingTwist(w, { relax: 0.7, max: 0.6, aHold: 0.03 });
  ctrl.twistDecay = 100;
  // Light sideslip → roll trim. The arm dihedral already provides the passive
  // restoring moment; this just nudges out residual slip. Kept small — high
  // slip gain over-corrected into a slow powered turn rather than damping it.
  ctrl.gains.slipRoll = 0.15;
  // Tail: pitch control surface. Negative hinge angle = TE up = downward tail force
  // aft of CG = nose-up moment. So all pitch signals must drive toward negative angles.
  ctrl.setPattern('tailMuscle', {
    frequency: 0, amplitude: 0, restAngle: -0.04,
    pitchBias: -0.4,
    flapScale: 0,
    stabPitch: -2.2,
  });
  // Active rudder (tail twist): yaw-rate damping + sideslip weathercock +
  // yaw-stick authority on the vertical fin strip.
  // Gains sized for the fin's 3D-corrected (halved) lift slope: the servo
  // deflects roughly twice as far for the same weathercock force.
  // Higher yawGain (0.9→1.4) + slipGain (0.08→0.14) to actively kill heading drift
  // before yawToRoll (now 0.4) can wind it into a spiral.
  ctrl.setRudder(tailFinStrip, { yawGain: 1.4, slipGain: 0.14, cmdGain: 0.55, max: 0.45 });
  // Active tail fan: spreading grows the physical tail area (flare/brake)
  ctrl.setTailFan(tailSurfaceStrip, { gain: 0.8 });
  c.flappingController = ctrl;

  // Wire wake-capture: shoulder joints signal stroke reversal; secondary strips
  // receive the transient pitchOffset injection at each downstroke onset.
  ctrl.setWakeCaptureSources({
    shoulderR: c.joints.get('shoulderR'),
    shoulderL: c.joints.get('shoulderL'),
    stripsR: wakeStripsR,
    stripsL: wakeStripsL,
  });

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
    // Legs: `leg: true` → renderer stretches them downward as creature.legExtend
    // rises (GroundController swings them out on landing approach)
    { parentSegId: torso.id, localPos: new Vec3( 0.028,  -0.073, 0.015),  shape: 'ellipsoid', dimensions: [0.012, 0.025, 0.012], color: 0xd09040, leg: true },
    { parentSegId: torso.id, localPos: new Vec3(-0.028,  -0.073, 0.015),  shape: 'ellipsoid', dimensions: [0.012, 0.025, 0.012], color: 0xd09040, leg: true },
    // Claws: 3 toes per foot (center + 2 side toes), fixed relative to torso
    // so they sit at the natural resting foot position
    { parentSegId: torso.id, localPos: new Vec3( 0.028,  -0.100,  0.001), shape: 'ellipsoid', dimensions: [0.0018, 0.0015, 0.011], color: 0x1e1408 },
    { parentSegId: torso.id, localPos: new Vec3( 0.021,  -0.100,  0.004), shape: 'ellipsoid', dimensions: [0.0018, 0.0015, 0.009], color: 0x1e1408 },
    { parentSegId: torso.id, localPos: new Vec3( 0.035,  -0.100,  0.004), shape: 'ellipsoid', dimensions: [0.0018, 0.0015, 0.009], color: 0x1e1408 },
    { parentSegId: torso.id, localPos: new Vec3(-0.028,  -0.100,  0.001), shape: 'ellipsoid', dimensions: [0.0018, 0.0015, 0.011], color: 0x1e1408 },
    { parentSegId: torso.id, localPos: new Vec3(-0.021,  -0.100,  0.004), shape: 'ellipsoid', dimensions: [0.0018, 0.0015, 0.009], color: 0x1e1408 },
    { parentSegId: torso.id, localPos: new Vec3(-0.035,  -0.100,  0.004), shape: 'ellipsoid', dimensions: [0.0018, 0.0015, 0.009], color: 0x1e1408 },
  ];

  // Covert feather rows (visual): lesser + median coverts shingled over the
  // secondaries' leading region on each arm, and primary coverts on the hand.
  c.visualFeathers = [];
  for (const side of [+1, -1]) {
    const arm = c.findSegmentByName(`arm${side > 0 ? 'R' : 'L'}`);
    const hand = c.findSegmentByName(`hand${side > 0 ? 'R' : 'L'}`);
    // Secondaries: individual aft-pointing feathers fanned along the arm's
    // trailing edge (the physical lift stays on the BET strips beneath; these
    // give the wing its real shingled trailing edge instead of a bare quad)
    for (let i = 0; i < 8; i++) {
      const t = i / 7;
      const x = side * (-0.085 + i * 0.0243);
      c.visualFeathers.push({
        segId: arm.id, localPos: new Vec3(x, -0.0015, 0.058),
        chord: 0.105, span: 0.030,
        pitch: 0.13, yaw: side * t * 0.16,
        color: i % 2 ? 0x90806a : 0x988770,
      });
    }
    for (let i = 0; i < 5; i++) {
      const x = side * (-0.075 + i * 0.0375);
      // lesser coverts: small, at the leading edge, darkest
      c.visualFeathers.push({
        segId: arm.id, localPos: new Vec3(x, 0.0045, -0.046),
        chord: 0.035, span: 0.036, pitch: 0.10, color: 0x7a6a56,
      });
      // median coverts: mid-chord row
      c.visualFeathers.push({
        segId: arm.id, localPos: new Vec3(x, 0.0035, -0.018),
        chord: 0.046, span: 0.036, pitch: 0.11, color: 0x8d7c64,
      });
    }
    for (let i = 0; i < 4; i++) {
      // primary coverts over the feather roots on the hand
      c.visualFeathers.push({
        segId: hand.id, localPos: new Vec3(side * (-0.06 + i * 0.04), 0.0035, -0.012),
        chord: 0.04, span: 0.038, pitch: 0.08, color: 0x83735e,
      });
    }
    // Inner-hand / carpal fill: aft-pointing feathers bridging the wrist gap
    // between the arm's secondaries and the swept primaries, so the trailing
    // edge is continuous from body to tip (no bare wedge behind the wrist).
    // Visual only — the BET primaries already carry this span's lift.
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      const x = side * (-0.085 + i * 0.024);
      c.visualFeathers.push({
        segId: hand.id, localPos: new Vec3(x, -0.001, 0.03),
        chord: 0.13 - t * 0.02, span: 0.040,
        pitch: 0.11, yaw: side * (0.10 + t * 0.30),
        color: i % 2 ? 0xb0a488 : 0xbcb094,
      });
    }
  }

  // Tail fan (visual): individual rectrices that fan out with tailSpread.
  // Replaces the tail plate's box mesh; the physical tailSurface strip
  // (invisible) grows its span in sync via ctrl.setTailFan above.
  c.tailFanVisual = {
    segId: tail.id, count: 7,
    root: new Vec3(0, 0.001, -0.068),
    length: 0.155, chord: 0.034,
    minFan: 0.30, maxFan: 0.95,    // total fan angle (rad) closed → spread
    color: 0x7e7060,
  };

  return c;
}
