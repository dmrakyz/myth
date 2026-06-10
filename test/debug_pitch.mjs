// Measure pitch torque about the creature CG contributed by each force group.
import { registerBuiltinProfiles } from '../js/fluid/BluntBodyData.js';
import { AirfoilData } from '../js/fluid/AirfoilData.js';
import { WaterSurface } from '../js/fluid/WaterSurface.js';
import { FluidMedium } from '../js/fluid/FluidMedium.js';
import { Vec3 } from '../js/math/Vec3.js';
import { Quat } from '../js/math/Quat.js';
import { rk4Step } from '../js/physics/Integrator.js';
import { solveConstraints } from '../js/physics/ConstraintSolver.js';
import { readFile } from 'fs/promises';

registerBuiltinProfiles();
const table = JSON.parse(await readFile(new URL('../assets/airfoil/naca2412.json', import.meta.url)));
new AirfoilData('naca2412', table);
const { createBird } = await import('../js/creature/presets/Bird.js');

const water = new WaterSurface({ level: -200 });
const medium = new FluidMedium(water);
const bird = createBird();
bird.placeAt(0, 100, 0);
bird.setVelocity(0, 0, -10);

const DT = 1 / 240;
const g = new Vec3(), cg = new Vec3(), arm = new Vec3(), tq = new Vec3();
const input = { pitchUp: 0, rollLeft: 0, yawLeft: 0, flapRate: 0, brake: 0 };
let t = 0;

// torque about CG along world x from a force at a point
function pitchTorque(point, force, cgPos) {
  Vec3.sub(point, cgPos, arm);
  return arm.y * force.z - arm.z * force.y; // (arm × F)·x̂
}

for (let i = 0; i < 240 * 1.2; i++) {
  t += DT;
  bird.flappingController.update(t, DT, input);
  bird.getCentroid(cg);

  let tqWings = 0, tqFeathers = 0, tqPanels = 0, tqTail = 0;

  for (const seg of bird.segments.values()) {
    for (const p of seg.bodyPanels) {
      p.computeForce(seg.rigidBody, medium, DT);
      tqPanels += pitchTorque(p.lastWorldPoint, p.lastForce, cg);
    }
  }
  for (const w of bird.wings.values()) {
    const seg = bird.segments.get(w.segmentId);
    for (const s of w.strips) {
      s.computeForce(seg.rigidBody, medium, DT);
      const tqv = pitchTorque(s.lastWorldPoint, s.lastForce, cg);
      if (w.name === 'tailSurface') tqTail += tqv; else tqWings += tqv;
    }
  }
  for (const fa of bird.featherArrays.values()) {
    const seg = bird.segments.get(fa.segmentId);
    for (const f of fa.feathers) {
      f.computeForce(seg.rigidBody, medium, DT);
      tqFeathers += pitchTorque(f.surface.lastWorldPoint, f.surface.lastForce, cg);
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
  solveConstraints(bird.getJointArray(), DT, 8, [...bird.muscles.values()]);

  if (i % 24 === 0) {
    const rb = bird.root.rigidBody;
    const fwd = new Vec3();
    Quat.rotateVec(rb.orientation, new Vec3(0, 0, -1), fwd);
    const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y))) * 180 / Math.PI;
    // Lift (total upward force) per group
    let liftW = 0, liftF = 0;
    for (const w of bird.wings.values()) for (const s of w.strips) liftW += s.lastForce.y;
    for (const fa of bird.featherArrays.values()) for (const f of fa.feathers) liftF += f.surface.lastForce.y;
    const tailMuscle = bird.muscles.get('tailMuscle');
    const tailAngle = bird.joints.get('tailJoint').getHingeAngle();
    console.log(
      `t=${t.toFixed(2)} pitch=${pitch.toFixed(1).padStart(6)}° | ` +
      `τwing=${tqWings.toFixed(3).padStart(7)} τfthr=${tqFeathers.toFixed(3).padStart(7)} ` +
      `τtail=${tqTail.toFixed(3).padStart(7)} τpanel=${tqPanels.toFixed(3).padStart(7)} | ` +
      `Lw=${liftW.toFixed(2).padStart(5)} Lf=${liftF.toFixed(2).padStart(5)} ` +
      `tailAng=${(tailAngle * 180 / Math.PI).toFixed(1).padStart(5)}° τm=${tailMuscle.lastTorque.toFixed(2)}`
    );
  }
}
