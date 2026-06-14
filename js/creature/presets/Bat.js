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
// Each wing has an arm (humerus+forearm) and three finger-bones that fan
// chordwise from the wrist: the existing hand bone is finger 2 (index,
// leading edge), finger 3 (middle) and finger 4 (ring) lie progressively
// further aft. The membrane is pinned along rows 0–2 so the three spar rows
// hold the wing in shape while rows 3–4 billow freely for lift.
const WRIST_X = 0.215;   // x-station where arm hands off to fingers

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

    // Arm bone (humerus + forearm): shoulder → wrist
    const arm = new Segment({
      name: `arm${sideName}`, shape: 'ellipsoid',
      dimensions: [0.085, 0.009, 0.012],
      mass: 0.018,
      position: new Vec3(side * 0.13, 0.015, -0.02),
      aeroProfile: 'bluntbody',
      noBodyPanels: true,
      color: 0x4a3a30,
    });
    c.addSegment(arm);

    // Finger 2 / index (leading-edge spar): wrist → tip  [row = 0]
    const hand = new Segment({
      name: `hand${sideName}`, shape: 'ellipsoid',
      dimensions: [0.10, 0.006, 0.008],
      mass: 0.008,
      position: new Vec3(side * 0.32, 0.015, -0.01),
      aeroProfile: 'bluntbody',
      noBodyPanels: true,
      color: 0x4a3a30,
    });
    c.addSegment(hand);

    // Shoulder hinge (flap axis = z)
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

    // Membrane grid: 7 cols (spanwise root→tip), 5 rows (leading→trailing edge)
    const COLS = 7, ROWS = 5;
    // Cols 0-2 lie over the arm, cols 3-6 over the fingers (WRIST_COL is the
    // first finger column, matching the WRIST_X position in x-space).
    const WRIST_COL = 3;
    const leRoot = [side * 0.05,  0.018, -0.04];  // shoulder leading point
    const leTip  = [side * 0.42,  0.018, -0.02];  // wingtip
    const teRoot = [side * 0.035, 0.004,  0.11];  // flank trailing root
    const teTip  = [side * 0.40,  0.004,  0.05];  // tip trailing corner

    // Finger 3 (middle): spans the row-1 spar from wrist to tip
    const f3Root = bilerp(leRoot, leTip, teRoot, teTip, WRIST_COL / (COLS - 1), 1 / (ROWS - 1));
    const f3Tip  = bilerp(leRoot, leTip, teRoot, teTip, 1.0,                    1 / (ROWS - 1));
    const f3HalfLen = Math.hypot(f3Tip[0] - f3Root[0], f3Tip[1] - f3Root[1], f3Tip[2] - f3Root[2]) / 2;
    const f3 = new Segment({
      name: `finger3${sideName}`, shape: 'ellipsoid',
      dimensions: [f3HalfLen, 0.004, 0.005],
      mass: 0.003,
      position: new Vec3((f3Root[0] + f3Tip[0]) / 2, (f3Root[1] + f3Tip[1]) / 2, (f3Root[2] + f3Tip[2]) / 2),
      aeroProfile: 'bluntbody', noBodyPanels: true, color: 0x4a3a30,
    });
    c.addSegment(f3);
    {
      const hp = hand.rigidBody.position, fp = f3.rigidBody.position;
      c.addJoint(`fingerJoint3${sideName}`, new Joint({
        bodyA: hand.rigidBody, bodyB: f3.rigidBody,
        pivotA: new Vec3(f3Root[0] - hp.x, f3Root[1] - hp.y, f3Root[2] - hp.z),
        pivotB: new Vec3(f3Root[0] - fp.x, f3Root[1] - fp.y, f3Root[2] - fp.z),
        type: 'fixed',
        axisA: new Vec3(1, 0, 0), axisB: new Vec3(1, 0, 0),
      }), hand.id, f3.id);
    }

    // Finger 4 (ring): spans the row-2 spar from wrist to tip
    const f4Root = bilerp(leRoot, leTip, teRoot, teTip, WRIST_COL / (COLS - 1), 2 / (ROWS - 1));
    const f4Tip  = bilerp(leRoot, leTip, teRoot, teTip, 1.0,                    2 / (ROWS - 1));
    const f4HalfLen = Math.hypot(f4Tip[0] - f4Root[0], f4Tip[1] - f4Root[1], f4Tip[2] - f4Root[2]) / 2;
    const f4 = new Segment({
      name: `finger4${sideName}`, shape: 'ellipsoid',
      dimensions: [f4HalfLen, 0.004, 0.005],
      mass: 0.003,
      position: new Vec3((f4Root[0] + f4Tip[0]) / 2, (f4Root[1] + f4Tip[1]) / 2, (f4Root[2] + f4Tip[2]) / 2),
      aeroProfile: 'bluntbody', noBodyPanels: true, color: 0x4a3a30,
    });
    c.addSegment(f4);
    {
      const hp = hand.rigidBody.position, fp = f4.rigidBody.position;
      c.addJoint(`fingerJoint4${sideName}`, new Joint({
        bodyA: hand.rigidBody, bodyB: f4.rigidBody,
        pivotA: new Vec3(f4Root[0] - hp.x, f4Root[1] - hp.y, f4Root[2] - hp.z),
        pivotB: new Vec3(f4Root[0] - fp.x, f4Root[1] - fp.y, f4Root[2] - fp.z),
        type: 'fixed',
        axisA: new Vec3(1, 0, 0), axisB: new Vec3(1, 0, 0),
      }), hand.id, f4.id);
    }

    // Build the membrane grid and pins.
    //
    // Pin layout (F=torso, a=arm, h=hand, 3=f3, 4=f4, .=free):
    //   row 0 (LE):  a  a  a  h  h  h  h    ← leading-edge spar (hand=index finger)
    //   row 1 (f3):  F  a  a  3  3  3  3    ← middle-finger spar
    //   row 2 (f4):  F  a  a  4  4  4  4    ← ring-finger spar
    //   row 3:       F  .  .  .  .  .  .    ← free trailing panels
    //   row 4 (TE):  F  .  .  .  .  .  .    ← free trailing edge
    //
    // Rows 3–4 can billow freely, creating the camber that generates lift.
    const initialPositions = [];
    const pins = [];
    const addPin = (seg, col, row, p) => {
      const sp = seg.rigidBody.position;
      pins.push({ segment: seg, col, row,
        localPoint: new Vec3(p[0] - sp.x, p[1] - sp.y, p[2] - sp.z) });
    };

    for (let r = 0; r < ROWS; r++) {
      for (let col = 0; col < COLS; col++) {
        const u = col / (COLS - 1);
        const v = r   / (ROWS - 1);
        const p = bilerp(leRoot, leTip, teRoot, teTip, u, v);
        initialPositions.push(p);

        if (r === 0) {
          // Leading-edge spar → arm (inboard) or hand/index (outboard)
          addPin(Math.abs(p[0]) <= WRIST_X ? arm : hand, col, r, p);
        } else if (col === 0) {
          // Body edge → torso (torso sits at world origin so world pos = local pos)
          pins.push({ segment: torso, col, row: r, localPoint: new Vec3(p[0], p[1], p[2]) });
        } else if (r === 1) {
          // Middle-finger spar: inboard cols to arm, outboard to f3
          addPin(col < WRIST_COL ? arm : f3, col, r, p);
        } else if (r === 2) {
          // Ring-finger spar: inboard cols to arm, outboard to f4
          addPin(col < WRIST_COL ? arm : f4, col, r, p);
        }
        // rows 3-4 (col > 0): free cloth that billows between the spars;
        // ClothBody's 0.92 per-substep damping suppresses oscillation.
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
  const FLAP_FREQ = 5.0;
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

  // --- Visual anatomy (ears, eyes, legs) ---
  head.addAttachedMass(0.002, new Vec3(0.012, 0.026, 0.004));
  head.addAttachedMass(0.002, new Vec3(-0.012, 0.026, 0.004));
  torso.addAttachedMass(0.006, new Vec3(0.026, -0.06, 0.06));
  torso.addAttachedMass(0.006, new Vec3(-0.026, -0.06, 0.06));

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
