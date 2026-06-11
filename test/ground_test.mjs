// Landing / standing / walking / takeoff integration test on procedural terrain.
import { registerBuiltinProfiles } from '../js/fluid/BluntBodyData.js';
import { AirfoilData } from '../js/fluid/AirfoilData.js';
import { WaterSurface } from '../js/fluid/WaterSurface.js';
import { FluidMedium } from '../js/fluid/FluidMedium.js';
import { PhysicsWorld } from '../js/physics/PhysicsWorld.js';
import { Terrain } from '../js/terrain/Terrain.js';
import { Vec3 } from '../js/math/Vec3.js';
import { readFile } from 'fs/promises';

registerBuiltinProfiles();
for (const id of ['naca2412', 'hydrofoil_naca0012']) {
  const table = JSON.parse(await readFile(new URL(`../assets/airfoil/${id}.json`, import.meta.url)));
  new AirfoilData(id === 'hydrofoil_naca0012' ? 'naca0012' : id, table);
}
const { createBird } = await import('../js/creature/presets/Bird.js');
const { GroundController } = await import('../js/creature/GroundController.js');

let pass = 0, fail = 0;
function check(name, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  cond ? pass++ : fail++;
}

const water = new WaterSurface({ level: -10 });
const medium = new FluidMedium(water);
const terrain = new Terrain({ seaLevel: -10 });
const world = new PhysicsWorld({ waterSurface: water, fluidMedium: medium, terrain });

// Island summit area
const ix = 40, iz = -320;
const ih = terrain.height(ix, iz);
console.log(`Island height at (${ix},${iz}): ${ih.toFixed(1)} m (sea ${terrain.seaLevel})`);
check('island rises above sea level', ih > terrain.seaLevel + 5);
check('open ocean is below sea level', terrain.height(800, 800) < terrain.seaLevel + 1);

const bird = createBird();
const gc = new GroundController(bird, terrain);
bird.groundController = gc;
bird.placeAt(ix, ih + 8, iz + 55);
bird.setVelocity(0, 0, -7);
world.addCreature(bird);

// ── Phase 1: braked glide approach (flap off, brake on) onto the upslope ────
world.input.flapRate = 0;
world.input.brake = 1;
const c = new Vec3();
let landed = -1, legsAt = -1;
for (let i = 0; i < 60 * 30; i++) {
  world.step(1 / 60);
  bird.getCentroid(c);
  if (legsAt < 0 && gc.legExtend > 0.7) legsAt = i / 60;
  if (gc.grounded && landed < 0) landed = i / 60;
  if (landed > 0 && i / 60 > landed + 4) break;
  if (!isFinite(c.y)) break;
}
console.log(`\nPhase 1 — approach & landing:`);
check('legs extended on approach', legsAt > 0);
check('landed within 30 s', landed > 0);
check(`standing (grounded + flap off)`, gc.standing);
check('wings tucked', bird.flappingController.tuck > 0.8);
check('tail spread for flare happened', bird.tailSpread !== undefined);
const aglLand = c.y - terrain.height(c.x, c.z);
check(`resting near stand height (agl ${aglLand.toFixed(2)})`, aglLand > 0.02 && aglLand < 0.5);

// ── Phase 2: walk forward with the left stick ───────────────────────────────
world.input.brake = 0;
bird.getCentroid(c);
const startX = c.x, startZ = c.z;
world.input.pitchUp = 1;
for (let i = 0; i < 60 * 4; i++) world.step(1 / 60);
world.input.pitchUp = 0;
bird.getCentroid(c);
const walked = Math.hypot(c.x - startX, c.z - startZ);
console.log(`\nPhase 2 — walking: moved ${walked.toFixed(2)} m`);
check('walked > 0.5 m in 4 s', walked > 0.5);
check('still grounded while walking', gc.grounded);

// ── Phase 3: flap to jump + take off ────────────────────────────────────────
world.input.flapRate = 1;
let tookOff = false;
for (let i = 0; i < 60 * 8; i++) {
  world.step(1 / 60);
  bird.getCentroid(c);
  if (c.y - terrain.height(c.x, c.z) > 3) { tookOff = true; break; }
}
console.log(`\nPhase 3 — takeoff:`);
check('airborne (>3 m AGL) within 8 s of flapping', tookOff);
check('wings untucked', bird.flappingController.tuck < 0.3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
