// A/B isolation: toggle twist gain / wrist waveform / amplitude via env vars
// to find which change destabilizes powered flight.
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

function run(label, mod) {
  const water = new WaterSurface({ level: -100 });
  const medium = new FluidMedium(water);
  const world = new PhysicsWorld({ waterSurface: water, fluidMedium: medium });
  const bird = createBird();
  bird.placeAt(0, 40, 0);
  bird.setVelocity(0, 0, -8);
  world.addCreature(bird);
  world.input.flapRate = 1.0;
  mod?.(bird);

  const centroid = new Vec3();
  const frameDt = 1 / 60;
  let ok = true;
  for (let i = 0; i <= 720; i++) {
    world.step(frameDt);
    bird.getCentroid(centroid);
    if (!isFinite(centroid.y)) { ok = false; break; }
  }
  bird.getCentroid(centroid);
  console.log(`${label.padEnd(46)} → alt Δ ${(centroid.y - 40).toFixed(1).padStart(6)} m  lat ${centroid.x.toFixed(1).padStart(6)} m ${ok ? '' : 'NaN!'}`);
}

run('full new config');
run('no twist', b => { b.flappingController.twists.length = 0; });
run('twist relax 0.1 max 0.25', b => { for (const t of b.flappingController.twists) { t.relax = 0.1; t.max = 0.25; } });
run('no twist, wrist amp 0.3', b => {
  b.flappingController.twists.length = 0;
  b.flappingController.patterns.get('wristR').amplitude = 0.3;
  b.flappingController.patterns.get('wristL').amplitude = -0.3;
});
run('no twist, wrist sine phase -1.2 (old wrists)', b => {
  b.flappingController.twists.length = 0;
  const wr = b.flappingController.patterns.get('wristR');
  const wl = b.flappingController.patterns.get('wristL');
  wr.waveform = 'sine'; wr.phase = -1.2; wr.amplitude = 0.3;
  wl.waveform = 'sine'; wl.phase = -1.2; wl.amplitude = -0.3;
});
run('no twist, old wrists, shoulder amp 0.45', b => {
  b.flappingController.twists.length = 0;
  const wr = b.flappingController.patterns.get('wristR');
  const wl = b.flappingController.patterns.get('wristL');
  wr.waveform = 'sine'; wr.phase = -1.2; wr.amplitude = 0.3;
  wl.waveform = 'sine'; wl.phase = -1.2; wl.amplitude = -0.3;
  b.flappingController.patterns.get('flapR').amplitude = 0.45;
  b.flappingController.patterns.get('flapL').amplitude = -0.45;
});
run('twist only (old wrists, amp 0.45)', b => {
  const wr = b.flappingController.patterns.get('wristR');
  const wl = b.flappingController.patterns.get('wristL');
  wr.waveform = 'sine'; wr.phase = -1.2; wr.amplitude = 0.3;
  wl.waveform = 'sine'; wl.phase = -1.2; wl.amplitude = -0.3;
  b.flappingController.patterns.get('flapR').amplitude = 0.45;
  b.flappingController.patterns.get('flapL').amplitude = -0.45;
});
run('foldup only (no twist, amp 0.45)', b => {
  b.flappingController.twists.length = 0;
  b.flappingController.patterns.get('flapR').amplitude = 0.45;
  b.flappingController.patterns.get('flapL').amplitude = -0.45;
});
run('amp 0.7 only (no twist, old wrists)', b => {
  b.flappingController.twists.length = 0;
  const wr = b.flappingController.patterns.get('wristR');
  const wl = b.flappingController.patterns.get('wristL');
  wr.waveform = 'sine'; wr.phase = -1.2; wr.amplitude = 0.3;
  wl.waveform = 'sine'; wl.phase = -1.2; wl.amplitude = -0.3;
});
