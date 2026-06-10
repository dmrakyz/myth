// Param sweep: flap frequency × shoulder amplitude → powered flight outcome.
import { registerBuiltinProfiles } from '../js/fluid/BluntBodyData.js';
import { AirfoilData } from '../js/fluid/AirfoilData.js';
import { WaterSurface } from '../js/fluid/WaterSurface.js';
import { FluidMedium } from '../js/fluid/FluidMedium.js';
import { PhysicsWorld } from '../js/physics/PhysicsWorld.js';
import { Vec3 } from '../js/math/Vec3.js';
import { readFile } from 'fs/promises';

registerBuiltinProfiles();
for (const id of ['naca2412', 'hydrofoil_naca0012']) {
  const table = JSON.parse(await readFile(new URL(`../assets/airfoil/${id}.json`, import.meta.url)));
  new AirfoilData(id === 'hydrofoil_naca0012' ? 'naca0012' : id, table);
}
const { createBird } = await import('../js/creature/presets/Bird.js');

function run(freq, amp, wristAmp, seconds = 8) {
  const water = new WaterSurface({ level: -100 });
  const medium = new FluidMedium(water);
  const world = new PhysicsWorld({ waterSurface: water, fluidMedium: medium });
  const bird = createBird();
  const ctrl = bird.flappingController;
  for (const id of ['flapR', 'flapL']) {
    const p = ctrl.patterns.get(id);
    p.frequency = freq;
    p.amplitude = Math.sign(p.amplitude) * amp;
  }
  for (const id of ['wristR', 'wristL']) {
    const p = ctrl.patterns.get(id);
    p.frequency = freq;
    p.amplitude = Math.sign(p.amplitude) * wristAmp;
  }
  bird.placeAt(0, 40, 0);
  bird.setVelocity(0, 0, -8);
  world.addCreature(bird);
  world.input.flapRate = 1;

  const frameDt = 1 / 60;
  const steps = Math.round(seconds / frameDt);
  const c = new Vec3();
  let ok = true;
  for (let i = 0; i <= steps; i++) {
    world.step(frameDt);
    bird.getCentroid(c);
    if (c.y < 0) { ok = false; break; }
  }
  const v = bird.root.rigidBody.velocity;
  return { alt: c.y, dist: -c.z, lat: c.x, fwd: -v.z, ok };
}

console.log('freq  amp  wAmp |   alt    dist    lat    fwd');
for (const freq of [3.0, 3.6, 4.2]) {
  for (const amp of [0.35, 0.5, 0.65]) {
    for (const wAmp of [0.2, 0.3]) {
      const r = run(freq, amp, wAmp);
      console.log(`${freq.toFixed(1)}  ${amp.toFixed(2)}  ${wAmp.toFixed(2)} | ` +
        `${r.alt.toFixed(1).padStart(6)} ${r.dist.toFixed(1).padStart(6)} ${r.lat.toFixed(1).padStart(6)} ${r.fwd.toFixed(1).padStart(5)}${r.ok ? '' : '  CRASHED'}`);
    }
  }
}
