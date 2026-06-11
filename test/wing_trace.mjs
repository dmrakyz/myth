// Diagnostic: trace orientation (pitch/roll/yaw), altitude, speed, and the
// actual shoulder stroke over a powered-flight run. Run: node test/wing_trace.mjs
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
  const pitch = Math.asin(Math.max(-1, Math.min(1, fwdW.y))) * 57.3;   // + = nose up
  const roll = Math.atan2(rightW.y, upW.y) * 57.3;                      // + = right wing up
  const yaw = Math.atan2(fwdW.x, -fwdW.z) * 57.3;                       // heading
  return { pitch, roll, yaw };
}

function run(label, { flapRate, seconds = 12, launchSpeed = 8 }) {
  const water = new WaterSurface({ level: -100 });
  const medium = new FluidMedium(water);
  const world = new PhysicsWorld({ waterSurface: water, fluidMedium: medium });
  const bird = createBird();
  bird.placeAt(0, 40, 0);
  bird.setVelocity(0, 0, -launchSpeed);
  world.addCreature(bird);
  world.input.flapRate = flapRate;

  const shoulderR = bird.joints.get('shoulderR');
  const centroid = new Vec3();
  const root = bird.root.rigidBody;

  console.log(`\n=== ${label} (flap=${flapRate}) ===`);
  console.log(' t     alt    vy    fwd   pitch  roll   yaw   shoulder°  beatHz');
  const frameDt = 1 / 60;
  const steps = Math.round(seconds / frameDt);
  let startAlt = 40;
  for (let i = 0; i <= steps; i++) {
    world.step(frameDt);
    if (i % 30 === 0) {
      bird.getCentroid(centroid);
      const v = root.velocity;
      const o = orientation(root);
      const sa = shoulderR.getHingeAngle() * 57.3;
      const hz = bird.flappingController.currentFrequency;
      console.log(
        `${(i * frameDt).toFixed(1).padStart(4)}  ${centroid.y.toFixed(1).padStart(5)}  ` +
        `${v.y.toFixed(1).padStart(5)}  ${(-v.z).toFixed(1).padStart(4)}  ` +
        `${o.pitch.toFixed(0).padStart(4)}°  ${o.roll.toFixed(0).padStart(4)}°  ${o.yaw.toFixed(0).padStart(4)}°  ` +
        `${sa.toFixed(1).padStart(7)}    ${hz.toFixed(2)}`);
    }
  }
  bird.getCentroid(centroid);
  const climb = centroid.y - startAlt;
  console.log(`  → net altitude change: ${climb >= 0 ? '+' : ''}${climb.toFixed(1)} m`);
  return climb;
}

run('POWERED', { flapRate: 1.0 });
run('GLIDE',   { flapRate: 0.0, seconds: 8 });
