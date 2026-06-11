// Long-run stability harness: 120 s powered flight, reports flips, roll RMS,
// altitude gain, lateral drift. Used to tune the stabilization reflexes.
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

const UP = new Vec3(0, 1, 0), FWD = new Vec3(0, 0, -1), RIGHT = new Vec3(1, 0, 0);
const uw = new Vec3(), fw = new Vec3(), rw = new Vec3();

export function longRun(label, mod, seconds = 120) {
  const water = new WaterSurface({ level: -100 });
  const medium = new FluidMedium(water);
  const world = new PhysicsWorld({ waterSurface: water, fluidMedium: medium });
  const bird = createBird();
  bird.placeAt(0, 40, 0);
  bird.setVelocity(0, 0, -8);
  world.addCreature(bird);
  world.input.flapRate = 1.0;
  mod?.(bird, world);

  const c = new Vec3();
  let flips = 0, lastUp = 1, rollSq = 0, rollMax = 0, n = 0, minAlt = 40, nan = false;
  const frames = Math.round(seconds * 60);
  for (let i = 0; i <= frames; i++) {
    world.step(1 / 60);
    bird.getCentroid(c);
    if (!isFinite(c.y)) { nan = true; break; }
    const rb = bird.root.rigidBody;
    Quat.rotateVec(rb.orientation, UP, uw);
    Quat.rotateVec(rb.orientation, RIGHT, rw);
    if (uw.y < 0 && lastUp >= 0) flips++;
    lastUp = uw.y;
    if (i > 120) {
      const roll = Math.atan2(rw.y, uw.y);
      rollSq += roll * roll; n++;
      rollMax = Math.max(rollMax, Math.abs(roll));
      minAlt = Math.min(minAlt, c.y);
    }
  }
  const rollRms = Math.sqrt(rollSq / Math.max(n, 1)) * 57.3;
  console.log(
    `${label.padEnd(44)} flips ${String(flips).padStart(2)}  rollRMS ${rollRms.toFixed(1).padStart(5)}°  rollMax ${(rollMax * 57.3).toFixed(0).padStart(4)}°  altΔ ${(c.y - 40).toFixed(1).padStart(7)} m  minAlt ${minAlt.toFixed(1).padStart(6)}  lat ${Math.hypot(c.x, 0).toFixed(0).padStart(5)} m${nan ? '  NaN!' : ''}`,
  );
  return { flips, rollRms, altGain: c.y - 40, minAlt };
}

// Run baseline when invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  longRun('baseline 120s', null);
}
