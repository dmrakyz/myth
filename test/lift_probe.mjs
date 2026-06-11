// Probe: measure net vertical aero force from the wing surfaces over wingbeat
// cycles, split downstroke vs upstroke. Tells us if the flap nets lift.
// Run: node test/lift_probe.mjs
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

function probe(label, flapRate) {
  const water = new WaterSurface({ level: -100 });
  const medium = new FluidMedium(water);
  const world = new PhysicsWorld({ waterSurface: water, fluidMedium: medium });
  const bird = createBird();
  bird.placeAt(0, 40, 0);
  bird.setVelocity(0, 0, -8);
  world.addCreature(bird);
  world.input.flapRate = flapRate;

  // Collect wing strips + feather surfaces that belong to the moving wings
  const surfaces = [];
  for (const wing of bird.wings.values()) {
    if (wing.name.startsWith('innerWing')) surfaces.push(...wing.strips);
  }
  for (const fa of bird.featherArrays.values()) {
    for (const f of fa.feathers) surfaces.push(f.surface);
  }
  const shoulderR = bird.joints.get('shoulderR');

  // Settle, then average vertical force over 3 s, gated by stroke direction
  for (let i = 0; i < 120; i++) world.step(1 / 60);

  let totalFy = 0, totalFz = 0, totalN = 0;
  let weight = 0;
  for (const seg of bird.segments.values()) weight += seg.rigidBody.mass * 9.81;

  // Sum aero force over ALL surfaces (wings + body + tail) for a true thrust
  // figure, plus a body-drag reference.
  const allSurfaces = [...surfaces];
  for (const seg of bird.segments.values()) allSurfaces.push(...seg.bodyPanels);
  for (const wing of bird.wings.values()) if (!wing.name.startsWith('innerWing')) allSurfaces.push(...wing.strips);

  const bodyPanels = [];
  for (const seg of bird.segments.values()) bodyPanels.push(...seg.bodyPanels);

  let wingFz = 0, bodyFz = 0;
  const frameDt = 1 / 60;
  for (let i = 0; i < 600; i++) {
    world.step(frameDt);
    let fy = 0, fz = 0;
    for (const s of allSurfaces) { fy += s.lastForce.y; fz += s.lastForce.z; }
    totalFy += fy; totalFz += fz; totalN++;
    for (const s of surfaces) wingFz += s.lastForce.z;
    for (const s of bodyPanels) bodyFz += s.lastForce.z;
  }
  const avgFy = totalFy / totalN;
  const avgThrust = -totalFz / totalN;  // −z is forward → +thrust
  console.log(`\n=== ${label} (flap=${flapRate}) ===`);
  console.log(`  weight to support:        ${weight.toFixed(2)} N`);
  console.log(`  avg total vertical force: ${avgFy.toFixed(2)} N  (${(avgFy/weight*100).toFixed(0)}% of weight)`);
  console.log(`  avg net forward force:    ${avgThrust >= 0 ? '+' : ''}${avgThrust.toFixed(2)} N  (>0 accelerates, <0 decelerates)`);
  console.log(`    wing fwd contribution:  ${(-wingFz/totalN >= 0 ? '+' : '')}${(-wingFz/totalN).toFixed(2)} N`);
  console.log(`    body drag:              ${(-bodyFz/totalN >= 0 ? '+' : '')}${(-bodyFz/totalN).toFixed(2)} N`);
  return avgFy;
}

probe('GLIDE', 0);
probe('POWERED', 1);
