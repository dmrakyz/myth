// Physics validation suite — run with: node test/physics_test.mjs
import { Vec3 } from '../js/math/Vec3.js';
import { Quat } from '../js/math/Quat.js';
import { Mat3 } from '../js/math/Mat3.js';
import { RigidBody } from '../js/physics/RigidBody.js';
import { rk4Step } from '../js/physics/Integrator.js';
import { Joint } from '../js/physics/Joint.js';
import { solveConstraints } from '../js/physics/ConstraintSolver.js';
import { Muscle } from '../js/physics/Muscle.js';
import { ellipsoidInertia } from '../js/physics/InertiaTensor.js';
import { AirfoilData } from '../js/fluid/AirfoilData.js';
import { registerBuiltinProfiles } from '../js/fluid/BluntBodyData.js';
import { FluidSurface } from '../js/fluid/FluidSurface.js';
import { WaterSurface } from '../js/fluid/WaterSurface.js';
import { FluidMedium } from '../js/fluid/FluidMedium.js';
import { ClothBody } from '../js/physics/ClothBody.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

registerBuiltinProfiles();
const DT = 1 / 240;

// ---- Test 1: free fall ----
console.log('Free fall (RK4, 1s):');
{
  const body = new RigidBody({ mass: 2 });
  const I = new Mat3();
  ellipsoidInertia(2, 0.1, 0.1, 0.1, I);
  body.setInertia(I);
  body.updateDerived();
  const g = new Vec3(0, -9.81 * 2, 0);
  for (let i = 0; i < 240; i++) {
    body.applyCentralForce(g);
    rk4Step(body, DT);
    body.clearAccumulators();
  }
  // y = -0.5 g t² = -4.905, v = -9.81
  check('position y ≈ -4.905', Math.abs(body.position.y + 4.905) < 1e-6, `got ${body.position.y}`);
  check('velocity y ≈ -9.81', Math.abs(body.velocity.y + 9.81) < 1e-6, `got ${body.velocity.y}`);
}

// ---- Test 2: torque-free spin conserves L, quaternion stays unit ----
console.log('Torque-free rotation (5s):');
{
  const body = new RigidBody({ mass: 1 });
  const I = new Mat3();
  ellipsoidInertia(1, 0.3, 0.1, 0.2, I); // asymmetric — tests tumbling
  body.setInertia(I);
  body.angMomentum.set(0.05, 0.2, 0.01);
  body.updateDerived();
  const L0 = Vec3.len(body.angMomentum);
  for (let i = 0; i < 1200; i++) {
    rk4Step(body, DT);
    body.clearAccumulators();
  }
  const L1 = Vec3.len(body.angMomentum);
  const q = body.orientation;
  const qLen = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
  check('angular momentum conserved', Math.abs(L1 - L0) / L0 < 1e-9, `ΔL/L=${(L1 - L0) / L0}`);
  check('quaternion unit length', Math.abs(qLen - 1) < 1e-9, `|q|=${qLen}`);
}

// ---- Test 3: BET lift magnitude and direction ----
console.log('BET strip — flat plate at 5° AoA, 10 m/s:');
{
  const water = new WaterSurface({ level: -1000 }); // far below — pure air
  const medium = new FluidMedium(water);
  const body = new RigidBody({ mass: 1, position: new Vec3(0, 100, 0) });
  const I = new Mat3();
  ellipsoidInertia(1, 0.1, 0.1, 0.1, I);
  body.setInertia(I);
  // Fly forward along -z at 10 m/s, pitch strip up 5°
  body.linMomentum.set(0, 0, -10);
  body.updateDerived();

  const strip = new FluidSurface({
    bodyPoint: new Vec3(0, 0, 0),
    chordDir: new Vec3(0, 0, 1),   // LE→TE backward
    spanDir: new Vec3(1, 0, 0),
    chord: 0.2, span: 1.0,
    airfoil: AirfoilData.get('flatplate'),
    camberAngle: 5 * Math.PI / 180,
  });
  strip.computeForce(body, medium);

  // Expected: alpha = 5°, Cl = 2π·α ≈ 0.548
  // L = 0.5 · 1.2126(ρ@100m) · 100 · 0.2 · 0.548 ≈ 6.65 N
  const alphaDeg = strip.lastAlpha * 180 / Math.PI;
  check('alpha ≈ 5°', Math.abs(alphaDeg - 5) < 0.2, `got ${alphaDeg}`);
  check('lift force is upward', strip.lastForce.y > 5, `Fy=${strip.lastForce.y}`);
  const rho = medium.airDensity(100);
  const expectedL = 0.5 * rho * 100 * 0.2 * (2 * Math.PI * 5 * Math.PI / 180);
  check('lift magnitude within 10%', Math.abs(strip.lastForce.y - expectedL) / expectedL < 0.10,
    `got ${strip.lastForce.y}, expected ~${expectedL.toFixed(2)}`);
  check('drag opposes motion (positive z)', strip.lastForce.z > 0, `Fz=${strip.lastForce.z}`);

  // Mirrored (left) wing must produce the same upward lift
  const stripL = new FluidSurface({
    bodyPoint: new Vec3(0, 0, 0),
    chordDir: new Vec3(0, 0, 1),
    spanDir: new Vec3(-1, 0, 0),  // span flipped
    chord: 0.2, span: 1.0,
    airfoil: AirfoilData.get('flatplate'),
    camberAngle: -5 * Math.PI / 180, // mirrored camber sign
  });
  body.clearAccumulators();
  stripL.computeForce(body, medium);
  check('mirrored strip lift matches', Math.abs(stripL.lastForce.y - strip.lastForce.y) < 0.01,
    `L=${stripL.lastForce.y} vs R=${strip.lastForce.y}`);
}

// ---- Test 4: ball joint holds bodies together under gravity ----
console.log('Ball joint under gravity (2s):');
{
  const makeBody = (y) => {
    const b = new RigidBody({ mass: 1, position: new Vec3(0, y, 0) });
    const I = new Mat3();
    ellipsoidInertia(1, 0.1, 0.1, 0.1, I);
    b.setInertia(I);
    b.updateDerived();
    return b;
  };
  const a = makeBody(0);
  a.kinematic = true; // fixed anchor
  const b = makeBody(-0.4);
  const joint = new Joint({
    bodyA: a, bodyB: b,
    pivotA: new Vec3(0, -0.2, 0),
    pivotB: new Vec3(0, 0.2, 0),
    type: 'ball',
  });
  const g = new Vec3(0, -9.81, 0);
  for (let i = 0; i < 480; i++) {
    b.applyCentralForce(g);
    rk4Step(b, DT);
    b.clearAccumulators();
    solveConstraints([joint], DT, 8);
  }
  const pA = new Vec3(), pB = new Vec3();
  joint.worldPivotA(pA); joint.worldPivotB(pB);
  const gap = Vec3.dist(pA, pB);
  check('pivot gap < 5 mm', gap < 0.005, `gap=${(gap * 1000).toFixed(2)}mm`);
  check('body B hangs below anchor', b.position.y < -0.3, `y=${b.position.y}`);
}

// ---- Test 5: hinge muscle drives toward target angle ----
console.log('Hinge + muscle servo (3s):');
{
  const makeBody = (y) => {
    const b = new RigidBody({ mass: 0.3, position: new Vec3(0, y, 0) });
    const I = new Mat3();
    ellipsoidInertia(0.3, 0.15, 0.03, 0.03, I);
    b.setInertia(I);
    b.updateDerived();
    return b;
  };
  const a = makeBody(0);
  a.kinematic = true;
  const b = makeBody(-0.3);
  const joint = new Joint({
    bodyA: a, bodyB: b,
    pivotA: new Vec3(0, -0.15, 0),
    pivotB: new Vec3(0, 0.15, 0),
    type: 'hinge',
    axisA: new Vec3(1, 0, 0),
    axisB: new Vec3(1, 0, 0),
  });
  const muscle = new Muscle({ joint, stiffness: 20, damping: 2, maxTorque: 50, restAngle: 0 });
  muscle.setTargetAngle(0.8);
  const g = new Vec3(0, -9.81 * 0.3, 0);
  for (let i = 0; i < 720; i++) {
    b.applyCentralForce(g);
    rk4Step(b, DT);
    b.clearAccumulators();
    solveConstraints([joint], DT, 8, [muscle]);
  }
  const angle = joint.getHingeAngle();
  // Gravity sags it slightly below target; just confirm it swung most of the way
  check('hinge angle near target 0.8 rad', Math.abs(angle - 0.8) < 0.25, `angle=${angle}`);
}

// ---- Test 6: buoyancy floats a light body, sinks a dense one ----
console.log('Buoyancy:');
{
  const { Buoyancy } = await import('../js/physics/Buoyancy.js');
  const { Segment } = await import('../js/creature/Segment.js');
  const water = new WaterSurface({ level: 0 });
  water.enabled = true;
  water.amplitudeScale = 0; // flat water
  const buoy = new Buoyancy(water);

  // Light segment (density ~ 300 kg/m³ → floats)
  const light = new Segment({
    shape: 'ellipsoid', dimensions: [0.1, 0.1, 0.1],
    mass: 300 * (4 / 3) * Math.PI * 0.001,
    position: new Vec3(0, -0.05, 0),
  });
  const g = new Vec3();
  for (let i = 0; i < 2400; i++) {
    buoy.applySegment(light);
    g.set(0, -9.81 * light.rigidBody.mass, 0);
    light.rigidBody.applyCentralForce(g);
    rk4Step(light.rigidBody, DT);
    light.rigidBody.clearAccumulators();
  }
  check('light body floats near surface', light.rigidBody.position.y > -0.1 && light.rigidBody.position.y < 0.2,
    `y=${light.rigidBody.position.y}`);

  const dense = new Segment({
    shape: 'ellipsoid', dimensions: [0.1, 0.1, 0.1],
    mass: 3000 * (4 / 3) * Math.PI * 0.001,
    position: new Vec3(0, -0.5, 0),
  });
  for (let i = 0; i < 480; i++) {
    buoy.applySegment(dense);
    g.set(0, -9.81 * dense.rigidBody.mass, 0);
    dense.rigidBody.applyCentralForce(g);
    rk4Step(dense.rigidBody, DT);
    dense.rigidBody.clearAccumulators();
  }
  check('dense body sinks', dense.rigidBody.position.y < -1.0, `y=${dense.rigidBody.position.y}`);
}

// ---- Test 7: XPBD cloth hangs and keeps constraint lengths ----
console.log('XPBD cloth (1s hang):');
{
  const cloth = new ClothBody(9); // 3x3
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      cloth.setParticle(r * 3 + c, c * 0.1, 0, r * 0.1, 0.01);
  // Pin top row by zero inv mass
  cloth.invMass[0] = 0; cloth.invMass[1] = 0; cloth.invMass[2] = 0;
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      if (c + 1 < 3) cloth.addDistanceConstraint(r * 3 + c, r * 3 + c + 1, 1e-7);
      if (r + 1 < 3) cloth.addDistanceConstraint(r * 3 + c, (r + 1) * 3 + c, 1e-7);
    }
  for (let i = 0; i < 240; i++) cloth.solve(DT, 4);
  // Bottom row should hang below the pinned row
  check('cloth hangs down', cloth.pos[8 * 3 + 1] < -0.05, `y=${cloth.pos[8 * 3 + 1]}`);
  // Check a constraint length stayed near rest
  const dx = cloth.pos[0] - cloth.pos[3 * 3];
  const dy = cloth.pos[1] - cloth.pos[3 * 3 + 1];
  const dz = cloth.pos[2] - cloth.pos[3 * 3 + 2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  check('constraint length ≈ rest (0.1)', Math.abs(len - 0.1) < 0.02, `len=${len}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
