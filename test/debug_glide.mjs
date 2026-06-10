// Instrument glide trim: attitude, AoA, force breakdown per group.
import { registerBuiltinProfiles } from '../js/fluid/BluntBodyData.js';
import { AirfoilData } from '../js/fluid/AirfoilData.js';
import { WaterSurface } from '../js/fluid/WaterSurface.js';
import { FluidMedium } from '../js/fluid/FluidMedium.js';
import { PhysicsWorld } from '../js/physics/PhysicsWorld.js';
import { Vec3 } from '../js/math/Vec3.js';
import { Quat } from '../js/math/Quat.js';
import { readFile } from 'fs/promises';

registerBuiltinProfiles();
const table = JSON.parse(await readFile(new URL('../assets/airfoil/naca2412.json', import.meta.url)));
new AirfoilData('naca2412', table);
const { createBird } = await import('../js/creature/presets/Bird.js');

const water = new WaterSurface({ level: -200 });
const medium = new FluidMedium(water);
const world = new PhysicsWorld({ waterSurface: water, fluidMedium: medium });
const bird = createBird();
bird.placeAt(0, 100, 0);
bird.setVelocity(0, 0, -10);
world.addCreature(bird);
world.input.flapRate = parseFloat(process.argv[2] ?? '0');

const fwd = new Vec3(), up = new Vec3();
const FWD_LOCAL = new Vec3(0, 0, -1), UP_LOCAL = new Vec3(0, 1, 0);

for (let i = 0; i <= 300; i++) {
  world.step(1 / 60);
  if (i % 15 !== 0) continue;

  const rb = bird.root.rigidBody;
  Quat.rotateVec(rb.orientation, FWD_LOCAL, fwd);
  Quat.rotateVec(rb.orientation, UP_LOCAL, up);
  const pitchDeg = Math.asin(Math.max(-1, Math.min(1, fwd.y))) * 180 / Math.PI;
  const rollDeg = Math.asin(Math.max(-1, Math.min(1, up.x))) * 180 / Math.PI;
  const v = rb.velocity;
  const flightPath = Math.atan2(v.y, Math.hypot(v.x, v.z)) * 180 / Math.PI;

  // Group forces (sample, last substep values)
  let wingF = 0, wingAlpha = 0, nStrips = 0;
  for (const w of bird.wings.values()) {
    for (const s of w.strips) {
      wingF += Vec3.len(s.lastForce);
      wingAlpha += s.lastAlpha * 180 / Math.PI;
      nStrips++;
    }
  }
  let featherF = 0, fAlpha = 0, nF = 0, fPitch = 0;
  for (const fa of bird.featherArrays.values()) {
    for (const f of fa.feathers) {
      featherF += Vec3.len(f.surface.lastForce);
      fAlpha += f.surface.lastAlpha * 180 / Math.PI;
      fPitch += f.pitch * 180 / Math.PI;
      nF++;
    }
  }
  let panelF = 0;
  for (const seg of bird.segments.values()) {
    for (const p of seg.bodyPanels) panelF += Vec3.len(p.lastForce);
  }

  const c = bird.getCentroid();
  console.log(
    `t=${(i / 60).toFixed(2).padStart(5)} alt=${c.y.toFixed(0).padStart(4)} ` +
    `spd=${Vec3.len(v).toFixed(1).padStart(4)} γ=${flightPath.toFixed(0).padStart(4)}° ` +
    `pitch=${pitchDeg.toFixed(0).padStart(4)}° roll=${rollDeg.toFixed(0).padStart(4)}° | ` +
    `wingα=${(wingAlpha / nStrips).toFixed(1).padStart(6)}° wingF=${wingF.toFixed(2).padStart(5)} ` +
    `fthrα=${(fAlpha / nF).toFixed(1).padStart(6)}° fthrF=${featherF.toFixed(2).padStart(5)} ` +
    `fthrPitch=${(fPitch / nF).toFixed(0).padStart(4)}° panelF=${panelF.toFixed(2)}`
  );
}
