// Attitude telemetry during glide: roll/pitch/AoA-proxy + speeds.
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

const water = new WaterSurface({ level: -100 });
const medium = new FluidMedium(water);
const world = new PhysicsWorld({ waterSurface: water, fluidMedium: medium });
const bird = createBird();
bird.placeAt(0, 40, 0);
bird.setVelocity(0, 0, -8);
world.addCreature(bird);
world.input.flapRate = 0;

const fwd = new Vec3(), up = new Vec3(), right = new Vec3();
const FWD = new Vec3(0, 0, -1), UP = new Vec3(0, 1, 0), RIGHT = new Vec3(1, 0, 0);

const frameDt = 1 / 60;
for (let i = 0; i <= 8 * 60; i++) {
  world.step(frameDt);
  if (i % 15 !== 0) continue;
  const rb = bird.root.rigidBody;
  Quat.rotateVec(rb.orientation, FWD, fwd);
  Quat.rotateVec(rb.orientation, UP, up);
  Quat.rotateVec(rb.orientation, RIGHT, right);
  const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y))) * 57.3;
  const roll = Math.atan2(right.y, up.y) * 57.3;
  const v = rb.velocity;
  const hs = Math.hypot(v.x, v.z);
  const fpa = Math.atan2(v.y, hs) * 57.3;
  // mean wing alpha
  let a = 0, n = 0;
  for (const wing of bird.wings.values()) {
    if (wing.name === 'tailSurface') continue;
    for (const s of wing.strips) { a += s.lastAlpha; n++; }
  }
  console.log(`t=${(i*frameDt).toFixed(2).padStart(5)} roll=${roll.toFixed(1).padStart(7)}° pitch=${pitch.toFixed(1).padStart(6)}° ` +
    `fpa=${fpa.toFixed(1).padStart(6)}° wingα=${(a/n*57.3).toFixed(1).padStart(5)}° ` +
    `spd=${Math.hypot(hs, v.y).toFixed(1).padStart(5)} vy=${v.y.toFixed(1).padStart(5)} alt=${rb.position.y.toFixed(1).padStart(5)}`);
}

console.log('\nMuscle positive work over 8s glide:');
for (const [id, m] of bird.muscles) {
  console.log(`  ${id.padEnd(12)} W+=${m.workDone.toFixed(2)} J  lastTorque=${m.lastTorque.toFixed(3)}`);
}
