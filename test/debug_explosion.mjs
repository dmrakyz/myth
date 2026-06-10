// Bisect the instability: toggle subsystems and watch substep-level state.
import { registerBuiltinProfiles } from '../js/fluid/BluntBodyData.js';
import { AirfoilData } from '../js/fluid/AirfoilData.js';
import { WaterSurface } from '../js/fluid/WaterSurface.js';
import { FluidMedium } from '../js/fluid/FluidMedium.js';
import { Vec3 } from '../js/math/Vec3.js';
import { rk4Step } from '../js/physics/Integrator.js';
import { solveConstraints } from '../js/physics/ConstraintSolver.js';
import { readFile } from 'fs/promises';

registerBuiltinProfiles();
for (const id of ['naca2412']) {
  const table = JSON.parse(await readFile(new URL(`../assets/airfoil/${id}.json`, import.meta.url)));
  new AirfoilData(id, table);
}
const { createBird } = await import('../js/creature/presets/Bird.js');

const cfg = {
  bodyPanels: process.argv.includes('panels'),
  wings: process.argv.includes('wings'),
  feathers: process.argv.includes('feathers'),
  muscles: process.argv.includes('muscles'),
  flapping: process.argv.includes('flapping'),
};
console.log('enabled:', JSON.stringify(cfg));

const water = new WaterSurface({ level: -100 });
const medium = new FluidMedium(water);
const bird = createBird();
bird.placeAt(0, 40, 0);
bird.setVelocity(0, 0, -8);

const DT = 1 / 240;
const g = new Vec3();
let t = 0;
const input = { pitchUp: 0, rollLeft: 0, yawLeft: 0, flapRate: 0.8, brake: 0 };

for (let i = 0; i < 240 * 4; i++) {
  t += DT;
  if (cfg.flapping) bird.flappingController.update(t, DT, input);

  if (cfg.bodyPanels) {
    for (const seg of bird.segments.values()) {
      for (const p of seg.bodyPanels) p.computeForce(seg.rigidBody, medium);
    }
  }
  if (cfg.wings) {
    for (const w of bird.wings.values()) {
      const seg = bird.segments.get(w.segmentId);
      w.computeForces(seg.rigidBody, medium);
    }
  }
  if (cfg.feathers) {
    for (const fa of bird.featherArrays.values()) {
      const seg = bird.segments.get(fa.segmentId);
      fa.computeForces(seg.rigidBody, medium, DT);
    }
  }
  for (const seg of bird.segments.values()) {
    g.set(0, -9.81 * seg.rigidBody.mass, 0);
    seg.rigidBody.applyCentralForce(g);
  }
  for (const seg of bird.segments.values()) {
    rk4Step(seg.rigidBody, DT);
    seg.rigidBody.clearAccumulators();
  }
  solveConstraints(bird.getJointArray(), DT, 8,
    cfg.muscles ? [...bird.muscles.values()] : null);

  // Monitor worst-case state
  let maxV = 0, maxW = 0, worst = '';
  for (const seg of bird.segments.values()) {
    const v = Vec3.len(seg.rigidBody.velocity);
    const w = Vec3.len(seg.rigidBody.angularVelocity);
    if (v > maxV) { maxV = v; worst = seg.name; }
    maxW = Math.max(maxW, w);
  }
  if (i % 60 === 0 || maxV > 200 || !isFinite(maxV)) {
    const c = bird.getCentroid();
    console.log(`t=${t.toFixed(3)} maxV=${maxV.toFixed(1)}(${worst}) maxW=${maxW.toFixed(1)} alt=${c.y.toFixed(1)}`);
    if (maxV > 200 || !isFinite(maxV)) { console.log('DIVERGED'); break; }
  }
}
