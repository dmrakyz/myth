// Diagnostic: trace orientation (pitch/roll/yaw), altitude, speed, and the
// actual shoulder/wrist strokes over a powered-flight run. Run: node test/wing_trace.mjs
import { registerBuiltinProfiles } from '../js/fluid/BluntBodyData.js';
import { AirfoilData } from '../js/fluid/AirfoilData.js';
import { WaterSurface } from '../js/fluid/WaterSurface.js';
import { FluidMedium } from '../js/fluid/FluidMedium.js';
import { PhysicsWorld } from '../js/physics/PhysicsWorld.js';
import { Vec3 } from '../js/math/Vec3.js';
import { Quat } from '../js/math/Quat.js';
import { readFile } from 'fs/promises';

registerBuiltinProfiles();
for (const id of ['naca2412', 'hydrofoil_naca0012']) {
  const table = JSON.parse(await readFile(new URL(`../assets/airfoil/${id}.json`, import.meta.url)));
  new AirfoilData(id === 'hydrofoil_naca0012' ? 'naca0012' : id, table);
}
const { createBird } = await import('../js/creature/presets/Bird.js');

const FWD = new Vec3(0, 0, -1), UP = new Vec3(0, 1, 0), RIGHT = new Vec3(1, 0, 0);
const fwdW = new Vec3(), upW = new Vec3(), rightW = new Vec3();

function orientation(rb) {
  Quat.rotateVec(rb.orientation, FWD, fwdW);
  Quat.rotateVec(rb.orientation, UP, upW);
  Quat.rotateVec(rb.orientation, RIGHT, rightW);
  const pitch = Math.asin(Math.max(-1, Math.min(1, fwdW.y))) * 57.3;
  const roll  = Math.atan2(rightW.y, upW.y) * 57.3;
  const yaw   = Math.atan2(fwdW.x, -fwdW.z) * 57.3;
  return { pitch, roll, yaw };
}

function run(label, { flapRate, pitchUp = 0, rollLeft = 0, seconds = 12, launchSpeed = 8, printInterval = 30 }) {
  const water = new WaterSurface({ level: -100 });
  const medium = new FluidMedium(water);
  const world = new PhysicsWorld({ waterSurface: water, fluidMedium: medium });
  const bird = createBird();
  bird.placeAt(0, 40, 0);
  bird.setVelocity(0, 0, -launchSpeed);
  world.addCreature(bird);
  world.input.flapRate = flapRate;
  world.input.pitchUp = pitchUp;
  world.input.rollLeft = rollLeft;

  const shoulderR = bird.joints.get('shoulderR');
  const shoulderL = bird.joints.get('shoulderL');
  const wristR    = bird.joints.get('wristR');
  const wristL    = bird.joints.get('wristL');
  const centroid  = new Vec3();
  const root      = bird.root.rigidBody;

  console.log(`\n=== ${label} (flap=${flapRate} roll=${rollLeft}) ===`);
  console.log(' t     alt    vy    pitch  roll   yaw   sR°   sL°   Δs°   wR°   wL°   beatHz');
  const frameDt = 1 / 60;
  const steps = Math.round(seconds / frameDt);
  const startAlt = 40;
  for (let i = 0; i <= steps; i++) {
    world.step(frameDt);
    if (i % printInterval === 0) {
      bird.getCentroid(centroid);
      const v = root.velocity;
      const o = orientation(root);
      const sR = shoulderR.getHingeAngle() * 57.3;
      const sL = shoulderL.getHingeAngle() * 57.3;
      const wR = wristR.getHingeAngle() * 57.3;
      const wL = wristL.getHingeAngle() * 57.3;
      const hz = bird.flappingController.currentFrequency;
      console.log(
        `${(i * frameDt).toFixed(1).padStart(4)}  ` +
        `${centroid.y.toFixed(1).padStart(5)}  ` +
        `${v.y.toFixed(1).padStart(5)}  ` +
        `${o.pitch.toFixed(0).padStart(4)}°  ${o.roll.toFixed(0).padStart(4)}°  ${o.yaw.toFixed(0).padStart(4)}°  ` +
        `${sR.toFixed(0).padStart(5)}  ${sL.toFixed(0).padStart(5)}  ${(sR+sL).toFixed(0).padStart(5)}  ` +
        `${wR.toFixed(0).padStart(5)}  ${wL.toFixed(0).padStart(5)}  ` +
        `${hz.toFixed(2)}`);
    }
  }
  bird.getCentroid(centroid);
  const climb = centroid.y - startAlt;
  console.log(`  → net altitude change: ${climb >= 0 ? '+' : ''}${climb.toFixed(1)} m`);
  return climb;
}

// Fine-grained beat trace: log every 6 frames (~0.1s) for first 6 seconds
function beatTrace(label, { flapRate }) {
  const water = new WaterSurface({ level: -100 });
  const medium = new FluidMedium(water);
  const world = new PhysicsWorld({ waterSurface: water, fluidMedium: medium });
  const bird = createBird();
  bird.placeAt(0, 40, 0);
  bird.setVelocity(0, 0, -8);
  world.addCreature(bird);
  world.input.flapRate = flapRate;

  const shoulderR = bird.joints.get('shoulderR');
  const shoulderL = bird.joints.get('shoulderL');

  console.log(`\n=== BEAT TRACE: ${label} ===`);
  console.log(' t      sR°    sL°    Δs°   (target sR cmd)');
  const frameDt = 1 / 60;
  const seconds = 4;
  const steps = Math.round(seconds / frameDt);
  // compute commanded target for sR: restAngle + amp * wave at current time
  for (let i = 0; i <= steps; i++) {
    world.step(frameDt);
    if (i % 6 === 0) {
      const sR = shoulderR.getHingeAngle() * 57.3;
      const sL = shoulderL.getHingeAngle() * 57.3;
      // commanded: restAngle=0.18, amp=0.45, freq=3, waveform=downbeat
      const t = i * frameDt;
      const freq = 3.0 * 1.0 * (0.5 + 0.5 * flapRate); // lerp(0.5,1.0,flap)
      const phase = 2 * Math.PI * freq * t;
      const pt = ((phase / (2 * Math.PI)) % 1 + 1) % 1;
      const wave = pt < 0.4
        ? Math.cos(pt / 0.4 * Math.PI)
        : Math.cos(Math.PI + (pt - 0.4) / 0.6 * Math.PI);
      const cmdR = (0.18 + 0.45 * flapRate * wave) * 57.3;
      console.log(
        `${t.toFixed(2).padStart(5)}  ` +
        `${sR.toFixed(1).padStart(6)}  ${sL.toFixed(1).padStart(6)}  ` +
        `${(sR + sL).toFixed(1).padStart(6)}  ` +
        `${cmdR.toFixed(1).padStart(6)}`);
    }
  }
}

// Roll authority test: does rollLeft actually roll the bird?
function rollTest() {
  const water = new WaterSurface({ level: -100 });
  const medium = new FluidMedium(water);
  const world = new PhysicsWorld({ waterSurface: water, fluidMedium: medium });
  const bird = createBird();
  bird.placeAt(0, 40, 0);
  bird.setVelocity(0, 0, -8);
  world.addCreature(bird);
  world.input.flapRate = 1.0;

  const shoulderR = bird.joints.get('shoulderR');
  const shoulderL = bird.joints.get('shoulderL');
  const wristR    = bird.joints.get('wristR');
  const wristL    = bird.joints.get('wristL');
  const root      = bird.root.rigidBody;
  const centroid  = new Vec3();

  console.log('\n=== ROLL AUTHORITY TEST ===');
  console.log('Phase 1: straight flight (3s), Phase 2: rollLeft=1 (3s), Phase 3: rollLeft=-1 (3s)');
  console.log(' t     roll°  sR°   sL°   wR°   wL°');

  const frameDt = 1 / 60;
  for (let i = 0; i <= 540; i++) {
    const t = i * frameDt;
    world.input.rollLeft = t < 3 ? 0 : t < 6 ? 1 : -1;
    world.step(frameDt);
    if (i % 18 === 0) {
      Quat.rotateVec(root.orientation, RIGHT, rightW);
      Quat.rotateVec(root.orientation, UP, upW);
      const roll = Math.atan2(rightW.y, upW.y) * 57.3;
      const sR = shoulderR.getHingeAngle() * 57.3;
      const sL = shoulderL.getHingeAngle() * 57.3;
      const wR = wristR.getHingeAngle() * 57.3;
      const wL = wristL.getHingeAngle() * 57.3;
      const marker = t < 3 ? '→' : t < 6 ? 'L' : 'R';
      console.log(`${t.toFixed(2).padStart(5)} ${marker}  ${roll.toFixed(1).padStart(6)}  ${sR.toFixed(1).padStart(5)}  ${sL.toFixed(1).padStart(5)}  ${wR.toFixed(1).padStart(5)}  ${wL.toFixed(1).padStart(5)}`);
    }
  }
}

beatTrace('POWERED', { flapRate: 1.0 });
run('POWERED',           { flapRate: 1.0, seconds: 12, printInterval: 18 });
run('CLIMB (pitchup)',   { flapRate: 1.0, pitchUp: 0.6, seconds: 8, printInterval: 18 });
run('GLIDE',             { flapRate: 0.0, seconds: 8, printInterval: 18 });
rollTest();
