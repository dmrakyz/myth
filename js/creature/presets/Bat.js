import { Vec3 } from '../../math/Vec3.js';
import { Creature } from '../Creature.js';
import { Segment } from '../Segment.js';
import { Joint } from '../../physics/Joint.js';
import { Muscle } from '../../physics/Muscle.js';
import { WingMembrane } from '../WingMembrane.js';
import { FlappingController } from '../FlappingController.js';

// Membrane-winged flyer (fruit-bat scale), ~0.30 kg, ~0.9 m span.
// Frame: forward = −z, up = +y, right = +x.
//
// Unlike the bird (BET strips + discrete feathers), each wing is a single
// XPBD cloth membrane stretched between the arm/hand bones (leading edge) and
// the flank (body edge). The cloth carries the aerodynamic load via the
// per-particle normal-pressure model in WingMembrane and feeds the resulting
// lift back onto the supporting bones. The flap drive is the same shoulder/
// wrist hinge rig the controller already understands.
const WRIST_X = 0.215;   // spanwise station where the arm bone hands off to the finger

// Bilinear interpolation of a grid node from the four membrane corners.
function bilerp(leRoot, leTip, teRoot, teTip, u, v) {
  const tx = leRoot[0] + (leTip[0] - leRoot[0]) * u;
  const ty = leRoot[1] + (leTip[1] - leRoot[1]) * u;
  const tz = leRoot[2] + (leTip[2] - leRoot[2]) * u;
  const bx = teRoot[0] + (teTip[0] - teRoot[0]) * u;
  const by = teRoot[1] + (teTip[1] - teRoot[1]) * u;
  const bz = teRoot[2] + (teTip[2] - teRoot[2]) * u;
  return [tx + (bx - tx) * v, ty + (by - ty) * v, tz + (bz - tz) * v];
}

export function createBat() {
  const c = new Creature('bat');

  // --- Torso ---
  const torso = new Segment({
    name: 'torso', shape: 'ellipsoid',
    dimensions: [0.045, 0.05, 0.11],
    mass: 0.16,
    position: new Vec3(0, 0, 0),
    aeroProfile: 'streamlined',
    color: 0x4a3a30,
  });
  c.addSegment(torso, true);

  // --- Head ---
  const head = new Segment({
    name: 'head', shape: 'ellipsoid',
    dimensions: [0.026, 0.026, 0.034],
    mass: 0.03,
    position: new Vec3(0, 0.03, -0.13),
    aeroProfile: 'streamlined',
    color: 0x5a4636,
  });
  c.addSegment(head);
  c.addJoint('neck', new Joint({
    bodyA: torso.rigidBody, bodyB: head.rigidBody,
    pivotA: new Vec3(0, 0.025, -0.10), pivotB: new Vec3(0, -0.005, 0.035),
    type: 'fixed',
    axisA: new Vec3(0, 0, 1), axisB: new Vec3(0, 0, 1),
  }), torso.id, head.id);

  // --- Wings (mirrored) ---
  for (const side of [+1, -1]) {
    const sideName = side > 0 ? 'R' : 'L';

    // Arm bone (humerus+forearm): shoulder ±0.045 → wrist ±0.215
    const arm = new Segment({
      name: `arm${sideName}`, shape: 'ellipsoid',
      dimensions: [0.085, 0.009, 0.012],
      mass: 0.018,
      position: new Vec3(side * 0.13, 0.015, -0.02),
      aeroProfile: 'bluntbody',
      noBodyPanels: true,    // membrane covers this span
      color: 0x4a3a30,
    });
    c.addSegment(arm);

    // Finger bone (hand): wrist ±0.215 → tip ±0.42
    const hand = new Segment({
      name: `hand${sideName}`, shape: 'ellipsoid',
      dimensions: [0.10, 0.006, 0.008],
      mass: 0.01,
      position: new Vec3(side * 0.32, 0.015, -0.01),
      aeroProfile: 'bluntbody',
      noBodyPanels: true,    // membrane covers this span
      color: 0x4a3a30,
    });
    c.addSegment(hand);

    // Shoulder hinge: flap axis = body fore-aft (z)
    const shoulder = c.addJoint(`shoulder${sideName}`, new Joint({
      bodyA: torso.rigidBody, bodyB: arm.rigidBody,
      pivotA: new Vec3(side * 0.045, 0.015, -0.02),
      pivotB: new Vec3(-side * 0.085, 0, 0),
      type: 'hinge',
      axisA: new Vec3(0, 0, 1), axisB: new Vec3(0, 0, 1),
      limits: { min: -1.2, max: 1.2 },
    }), torso.id, arm.id);
    c.addMuscle(`flap${sideName}`, new Muscle({
      joint: shoulder, stiffness: 40, damping: 1.5, maxTorque: 12, restAngle: 0,
    }), `shoulder${sideName}`);

    // Wrist hinge
    const wrist = c.addJoint(`wrist${sideName}`, new Joint({
      bodyA: arm.rigidBody, bodyB: hand.rigidBody,
      pivotA: new Vec3(side * 0.085, 0, 0),
      pivotB: new Vec3(-side * 0.10, 0, 0),
      type: 'hinge',
      axisA: new Vec3(0, 0, 1), axisB: new Vec3(0, 0, 1),
      limits: { min: -0.9, max: 0.9 },
    }), arm.id, hand.id);
    c.addMuscle(`wrist${sideName}`, new Muscle({
      joint: wrist, stiffness: 8, damping: 0.8, maxTorque: 4, restAngle: 0,
    }), `wrist${sideName}`);

    // Membrane grid: cols run spanwise (root → tip), rows chordwise
    // (leading edge → trailing edge). The leading-edge row welds to the
    // arm/finger bones; the root column welds along the flank to the torso.
    // The trailing edge and tip are free to billow under load.
    const COLS = 7, ROWS = 5;
    // Leading edge sits high, trailing edge drops uniformly below it so the
    // whole membrane carries a consistent positive geometric incidence (~6°)
    // and makes lift in forward flight instead of cupping into a parachute.
    const leRoot = [side * 0.05, 0.018, -0.04];   // shoulder leading point
    const leTip  = [side * 0.42, 0.018, -0.02];   // wingtip
    const teRoot = [side * 0.035, 0.004, 0.11];   // flank/ankle trailing root
    const teTip  = [side * 0.40, 0.004, 0.05];    // trailing point near the tip

    const initialPositions = [];
    const pins = [];
    for (let r = 0; r < ROWS; r++) {
      for (let col = 0; col < COLS; col++) {
        const u = COLS > 1 ? col / (COLS - 1) : 0;
        const v = ROWS > 1 ? r / (ROWS - 1) : 0;
        const p = bilerp(leRoot, leTip, teRoot, teTip, u, v);
        initialPositions.push(p);

        // Leading edge → nearest bone (arm inboard of the wrist, finger beyond)
        if (r === 0) {
          const onArm = Math.abs(p[0]) <= WRIST_X;
          const seg = onArm ? arm : hand;
          const sp = seg.rigidBody.position;
          pins.push({
            segment: seg, col, row: r,
            localPoint: new Vec3(p[0] - sp.x, p[1] - sp.y, p[2] - sp.z),
          });
        } else if (col === 0) {
          // Body edge → torso flank (membrane root attaches along the body)
          pins.push({
            segment: torso, col, row: r,
            localPoint: new Vec3(p[0], p[1], p[2]),
          });
        }
      }
    }

    c.addMembrane(new WingMembrane({
      name: `wing${sideName}`,
      cols: COLS, rows: ROWS,
      pins, initialPositions,
      particleMass: 0.002,
      compliance: 2e-5,
      color: 0x6b4a3a,
    }));
  }

  // --- Flapping controller ---
  const ctrl = new FlappingController(c);
  const FLAP_FREQ = 5.0;   // bats beat faster than gulls
  ctrl.setPattern('flapR', {
    frequency: FLAP_FREQ, amplitude: 1.0, phase: 0, restAngle: 0.20,
    waveform: 'downbeat', stabRoll: -0.40, tuckAngle: 0.30, brakeAngle: 0.35,
  });
  ctrl.setPattern('flapL', {
    frequency: FLAP_FREQ, amplitude: -1.0, phase: 0, restAngle: -0.20,
    waveform: 'downbeat', stabRoll: -0.40, tuckAngle: -0.30, brakeAngle: -0.35,
  });
  ctrl.setPattern('wristR', {
    frequency: FLAP_FREQ, amplitude: 0.40, phase: 0, restAngle: -0.30,
    waveform: 'upwhip', stabRoll: -0.30, tuckAngle: -0.80,
  });
  ctrl.setPattern('wristL', {
    frequency: FLAP_FREQ, amplitude: -0.40, phase: 0, restAngle: 0.30,
    waveform: 'upwhip', stabRoll: -0.30, tuckAngle: 0.80,
  });
  ctrl.gains.slipRoll = 0.15;
  c.flappingController = ctrl;

  // --- Visual anatomy (ears, legs) ---
  head.addAttachedMass(0.002, new Vec3(0.012, 0.026, 0.004));   // earR
  head.addAttachedMass(0.002, new Vec3(-0.012, 0.026, 0.004));  // earL
  torso.addAttachedMass(0.006, new Vec3(0.026, -0.06, 0.06));   // legR
  torso.addAttachedMass(0.006, new Vec3(-0.026, -0.06, 0.06));  // legL

  c.visualAttachments = [
    { parentSegId: head.id, localPos: new Vec3(0.013, 0.030, 0.004), shape: 'ellipsoid', dimensions: [0.008, 0.018, 0.004], color: 0x5a4636 },
    { parentSegId: head.id, localPos: new Vec3(-0.013, 0.030, 0.004), shape: 'ellipsoid', dimensions: [0.008, 0.018, 0.004], color: 0x5a4636 },
    { parentSegId: head.id, localPos: new Vec3(0.016, 0.004, -0.012), shape: 'ellipsoid', dimensions: [0.006, 0.006, 0.004], color: 0x140d08 },
    { parentSegId: head.id, localPos: new Vec3(-0.016, 0.004, -0.012), shape: 'ellipsoid', dimensions: [0.006, 0.006, 0.004], color: 0x140d08 },
    { parentSegId: torso.id, localPos: new Vec3(0.026, -0.06, 0.06), shape: 'ellipsoid', dimensions: [0.010, 0.022, 0.010], color: 0x40322a, leg: true },
    { parentSegId: torso.id, localPos: new Vec3(-0.026, -0.06, 0.06), shape: 'ellipsoid', dimensions: [0.010, 0.022, 0.010], color: 0x40322a, leg: true },
  ];

  return c;
}
