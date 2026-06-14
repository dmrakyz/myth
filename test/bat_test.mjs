// Membrane-wing smoke test: build the bat, launch it, flap, and confirm the
// cloth membrane physics stays stable (no NaN, no explosion) and the creature
// stays airborne through a short flight. Run: node test/bat_test.mjs
import { registerBuiltinProfiles } from '../js/fluid/BluntBodyData.js';
import { WaterSurface } from '../js/fluid/WaterSurface.js';
import { FluidMedium } from '../js/fluid/FluidMedium.js';
import { PhysicsWorld } from '../js/physics/PhysicsWorld.js';
import { Vec3 } from '../js/math/Vec3.js';

registerBuiltinProfiles();

const { createBat } = await import('../js/creature/presets/Bat.js');

function simulate(label, { flapRate, seconds = 8, launchSpeed = 8 }) {
  const water = new WaterSurface({ level: -100 });
  const medium = new FluidMedium(water);
  const world = new PhysicsWorld({ waterSurface: water, fluidMedium: medium });

  const bat = createBat();
  bat.placeAt(0, 40, 0);
  bat.setVelocity(0, 0, -launchSpeed);
  world.addCreature(bat);
  world.input.flapRate = flapRate;

  console.log(`\n=== ${label} (flap=${flapRate}, ${seconds}s) ===`);
  const frameDt = 1 / 60;
  const steps = Math.round(seconds / frameDt);
  let minY = Infinity, maxSpeed = 0, exploded = false;
  const centroid = new Vec3();

  for (let i = 0; i <= steps; i++) {
    world.step(frameDt);
    bat.getCentroid(centroid);
    const v = bat.root.rigidBody.velocity;
    const speed = Vec3.len(v);
    minY = Math.min(minY, centroid.y);
    maxSpeed = Math.max(maxSpeed, speed);

    // Membrane particle NaN check
    for (const mem of bat.membranes.values()) {
      const pos = mem.cloth.pos;
      if (!isFinite(pos[0]) || !isFinite(pos[pos.length - 1])) { exploded = true; break; }
    }

    if (i % 120 === 0) {
      let memF = 0;
      for (const mem of bat.membranes.values()) memF += mem.lastTotalForce;
      console.log(`t=${(i * frameDt).toFixed(1).padStart(5)}s  alt=${centroid.y.toFixed(1).padStart(6)}m  ` +
        `fwd=${(-v.z).toFixed(1).padStart(5)}m/s  vy=${v.y.toFixed(1).padStart(5)}  ` +
        `spd=${speed.toFixed(1).padStart(5)}  memForce=${memF.toFixed(1)}N`);
    }
    if (exploded || !isFinite(centroid.y)) { console.log('   NaN EXPLOSION'); break; }
    if (centroid.y < -90) { console.log('   CRASHED INTO ABYSS'); break; }
  }
  bat.getCentroid(centroid);
  const v = bat.root.rigidBody.velocity;
  return { finalAlt: centroid.y, finalFwd: -v.z, minY, maxSpeed, exploded: exploded || !isFinite(centroid.y) };
}

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

// Glide: membrane should carry load without exploding; bat descends in control
{
  const r = simulate('GLIDE', { flapRate: 0, seconds: 8 });
  check('no NaN / cloth explosion', !r.exploded);
  check('speed bounded < 40 m/s (no membrane runaway)', r.maxSpeed < 40, `max=${r.maxSpeed.toFixed(1)}`);
  check('stays above the abyss', r.minY > -90, `minY=${r.minY.toFixed(1)}`);
}

// Powered: flapping should drive the membrane without instability
{
  const r = simulate('POWERED', { flapRate: 1.0, seconds: 10 });
  check('no NaN / cloth explosion', !r.exploded);
  check('speed bounded < 40 m/s', r.maxSpeed < 40, `max=${r.maxSpeed.toFixed(1)}`);
  check('flapping keeps it airborne longer than free-fall', r.minY > -50, `minY=${r.minY.toFixed(1)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
