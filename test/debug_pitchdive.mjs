// Pitch divergence debug: per-group pitch torque about CG + tail state, fine timestep.
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

const fwd = new Vec3(), rightW = new Vec3();
const FWD = new Vec3(0, 0, -1), RIGHT = new Vec3(1, 0, 0);
const cg = new Vec3(), r = new Vec3(), tau = new Vec3();

function groupTorque(strips, axis) {
  let t = 0;
  for (const s of strips) {
    Vec3.sub(s.lastWorldPoint, cg, r);
    Vec3.cross(r, s.lastForce, tau);
    t += Vec3.dot(tau, axis);
  }
  return t;
}

function dump(t) {
  const rb = bird.root.rigidBody;
  Quat.rotateVec(rb.orientation, FWD, fwd);
  Quat.rotateVec(rb.orientation, RIGHT, rightW);
  const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y))) * 57.3;
  // Mass-weighted CG, rolled back one 240 Hz substep to match the capture
  // time of strip lastWorldPoint telemetry (avoids a phantom v*h*L torque)
  cg.set(0, 0, 0);
  let M = 0;
  for (const seg of bird.segments.values()) {
    Vec3.addScaled(cg, seg.rigidBody.position, seg.rigidBody.mass, cg);
    M += seg.rigidBody.mass;
  }
  Vec3.scale(cg, 1 / M, cg);
  Vec3.addScaled(cg, rb.velocity, -1 / 240, cg);

  const wingStrips = [], tailStrips = [], feaStrips = [], bodyStrips = [];
  for (const wing of bird.wings.values()) {
    (wing.name === 'tailSurface' ? tailStrips : wingStrips).push(...wing.strips);
  }
  for (const fa of bird.featherArrays.values()) for (const f of fa.feathers) feaStrips.push(f.surface);
  for (const seg of bird.segments.values()) bodyStrips.push(...seg.bodyPanels);

  const tw = groupTorque(wingStrips, rightW);
  const tt = groupTorque(tailStrips, rightW);
  const tf = groupTorque(feaStrips, rightW);
  const tb = groupTorque(bodyStrips, rightW);
  const tailJ = bird.joints.get('tailJoint');
  const tailAngle = tailJ.getHingeAngle();
  const tailMus = bird.muscles.get('tailMuscle');
  const q = Vec3.dot(rb.angularVelocity, rightW);

  console.log(`t=${t.toFixed(2).padStart(5)} pitch=${pitch.toFixed(1).padStart(6)}° q=${q.toFixed(2).padStart(6)} | ` +
    `τwing=${tw.toFixed(3).padStart(7)} τfea=${tf.toFixed(3).padStart(7)} τtail=${tt.toFixed(3).padStart(7)} τbody=${tb.toFixed(3).padStart(7)} | ` +
    `tailAng=${(tailAngle*57.3).toFixed(1).padStart(6)}° tgt=${(tailMus.targetAngle*57.3).toFixed(1).padStart(6)}°`);
}

const frameDt = 1 / 60;
for (let i = 0; i <= 2.5 * 60; i++) {
  world.step(frameDt);
  if (i % 6 === 0) dump(i * frameDt);
}
