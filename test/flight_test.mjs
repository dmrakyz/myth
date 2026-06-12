// Full-system flight test: build the bird, launch it, flap, observe.
// Run: node test/flight_test.mjs
import { registerBuiltinProfiles } from '../js/fluid/BluntBodyData.js';
import { AirfoilData } from '../js/fluid/AirfoilData.js';
import { WaterSurface } from '../js/fluid/WaterSurface.js';
import { FluidMedium } from '../js/fluid/FluidMedium.js';
import { PhysicsWorld } from '../js/physics/PhysicsWorld.js';
import { Vec3 } from '../js/math/Vec3.js';
import { readFile } from 'fs/promises';

registerBuiltinProfiles();
// Load airfoil tables from disk (browser uses fetch)
for (const id of ['naca2412', 'hydrofoil_naca0012']) {
  const table = JSON.parse(await readFile(new URL(`../assets/airfoil/${id}.json`, import.meta.url)));
  new AirfoilData(id === 'hydrofoil_naca0012' ? 'naca0012' : id, table);
}

const { createBird } = await import('../js/creature/presets/Bird.js');

function simulate(label, { flapRate, pitchUp = 0, rollLeft = 0, seconds = 10, launchSpeed = 8 }) {
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

  console.log(`\n=== ${label} (flap=${flapRate}, ${seconds}s) ===`);
  const frameDt = 1 / 60;
  const steps = Math.round(seconds / frameDt);
  let minY = Infinity, maxSpeed = 0;
  const centroid = new Vec3();

  for (let i = 0; i <= steps; i++) {
    world.step(frameDt);
    bird.getCentroid(centroid);
    const v = bird.root.rigidBody.velocity;
    const speed = Vec3.len(v);
    minY = Math.min(minY, centroid.y);
    maxSpeed = Math.max(maxSpeed, speed);
    if (i % 120 === 0) {
      console.log(`t=${(i * frameDt).toFixed(1).padStart(5)}s  alt=${centroid.y.toFixed(1).padStart(6)}m  ` +
        `fwd=${(-v.z).toFixed(1).padStart(5)}m/s  vy=${v.y.toFixed(1).padStart(5)}  ` +
        `lat=${centroid.x.toFixed(1).padStart(5)}m  spd=${speed.toFixed(1)}`);
    }
    if (centroid.y < -90) { console.log('   CRASHED INTO ABYSS'); break; }
    if (!isFinite(centroid.y)) { console.log('   NaN EXPLOSION'); break; }
  }
  bird.getCentroid(centroid);
  const v = bird.root.rigidBody.velocity;
  return { finalAlt: centroid.y, finalFwd: -v.z, dist: -centroid.z, lateral: centroid.x, minY, maxSpeed };
}

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

// Test 1: glide (no flapping) — should descend in a controlled glide, not tumble
{
  const r = simulate('GLIDE', { flapRate: 0, seconds: 8 });
  check('stays airborne 8s (alt > 0 from 40m)', r.minY > 0, `minY=${r.minY.toFixed(1)}`);
  check('maintains forward speed > 4 m/s', r.finalFwd > 4, `fwd=${r.finalFwd.toFixed(1)}`);
  const glideRatio = r.dist / (40 - r.finalAlt);
  check(`glide ratio > 2 (got ${glideRatio.toFixed(1)})`, glideRatio > 2);
  check('speed bounded < 30 m/s (no dive runaway)', r.maxSpeed < 30, `max=${r.maxSpeed.toFixed(1)}`);
}

// Test 2: powered flight — flapping should sustain or gain altitude
{
  const r = simulate('POWERED', { flapRate: 1.0, seconds: 10 });
  check('altitude sustained (final > 25m from 40m)', r.finalAlt > 25, `alt=${r.finalAlt.toFixed(1)}`);
  check('forward progress > 30m', r.dist > 30, `dist=${r.dist.toFixed(1)}`);
  check('roughly straight (|lateral| < 15m)', Math.abs(r.lateral) < 15, `lat=${r.lateral.toFixed(1)}`);
}

// Test 3: pitch control changes flight path
{
  const up = simulate('PITCH UP', { flapRate: 1.0, pitchUp: 0.5, seconds: 6 });
  const dn = simulate('PITCH DOWN', { flapRate: 1.0, pitchUp: -0.5, seconds: 6 });
  check('pitch input affects altitude (up > down)', up.finalAlt > dn.finalAlt + 1,
    `up=${up.finalAlt.toFixed(1)} dn=${dn.finalAlt.toFixed(1)}`);
}

// Test 4: roll input causes turning
{
  const r = simulate('ROLL LEFT', { flapRate: 1.0, rollLeft: 0.6, seconds: 8 });
  check('roll causes lateral deviation > 3m', Math.abs(r.lateral) > 3, `lat=${r.lateral.toFixed(1)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
