import { Vec3 } from '../math/Vec3.js';
import { Mat3 } from '../math/Mat3.js';
import { RigidBody } from '../physics/RigidBody.js';
import { inertiaForShape, volumeForShape, boundingRadiusForShape } from '../physics/InertiaTensor.js';
import { AirfoilData } from '../fluid/AirfoilData.js';
import { FluidSurface } from '../fluid/FluidSurface.js';

// A body segment: rigid body + shape descriptor + auto-generated BET panels
// so that EVERY part of a creature induces drag (and crossflow lift). The
// panels approximate the segment's projected area along its three principal
// axes; the airfoil profile is 'bluntbody' by default and can be overridden
// per segment in the builder ('streamlined' for fusiform torsos, or even a
// lifting profile for lifting-body designs).
let nextSegmentId = 1;

export class Segment {
  constructor({
    name = 'segment',
    shape = 'ellipsoid',
    dimensions = [0.1, 0.1, 0.1],
    mass = 0.1,
    position = null,
    orientation = null,
    aeroProfile = 'bluntbody',
    color = 0x8899aa,
    noBodyPanels = false,   // segments fully covered by explicit Wing strips
  } = {}) {
    this.id = `seg_${nextSegmentId++}`;
    this.name = name;
    this.shape = shape;
    this.dimensions = dimensions.slice();
    this.aeroProfile = aeroProfile;
    this.color = color;
    this.noBodyPanels = noBodyPanels;

    this.baseMass = mass;
    this.rigidBody = new RigidBody({ mass, position, orientation });
    this.bodyPanels = [];      // auto FluidSurfaces
    this.attachedMasses = [];  // { mass, point:Vec3 } — feathers, wing strips
    this._inertia = new Mat3();

    this.recalculate();
  }

  get mass() { return this.rigidBody.mass; }

  // Register mass rigidly attached at a body-frame point (feather vanes,
  // wing strips). Their inertia contribution is what makes light wing bones
  // numerically and physically well-behaved under aero loads.
  addAttachedMass(mass, point) {
    this.attachedMasses.push({ mass, point: point.clone() });
    this.recalculate();
  }

  clearAttachedMasses() {
    this.attachedMasses.length = 0;
    this.recalculate();
  }

  recalculate() {
    const d = this.dimensions;
    this.volume = volumeForShape(this.shape, d);
    this.boundingRadius = boundingRadiusForShape(this.shape, d);
    // Vertical half-extent for ground contact: an elongated body (torso lies
    // along z) touches ground at its belly, not at its bounding sphere.
    switch (this.shape) {
      case 'ellipsoid': case 'box': this.contactRadius = d[1]; break;
      case 'capsule': this.contactRadius = d[0]; break;
      case 'plate': this.contactRadius = 0.005; break;
      default: this.contactRadius = this.boundingRadius;
    }

    // Ground-contact sample points: center plus the tips of elongated axes,
    // so wing-bone tips and tail edges collide with terrain instead of
    // sweeping through it (the center-only test let wingtips clip in dives).
    let hx, hy, hz;
    switch (this.shape) {
      case 'ellipsoid': case 'box': hx = d[0]; hy = d[1]; hz = d[2]; break;
      case 'capsule':   hx = d[0]; hy = d[0]; hz = d[0] + d[1]; break;
      case 'plate':     hx = d[1] * 0.5; hy = 0.005; hz = d[0] * 0.5; break;
      default:          hx = hy = hz = this.boundingRadius;
    }
    this.contactPoints = [{ p: new Vec3(0, 0, 0), r: this.contactRadius }];
    const tipR = Math.max(0.006, Math.min(hy, this.contactRadius));
    if (hx > 3 * this.contactRadius) {
      this.contactPoints.push({ p: new Vec3( hx * 0.95, 0, 0), r: tipR });
      this.contactPoints.push({ p: new Vec3(-hx * 0.95, 0, 0), r: tipR });
    }
    if (hz > 3 * this.contactRadius) {
      this.contactPoints.push({ p: new Vec3(0, 0,  hz * 0.95), r: tipR });
      this.contactPoints.push({ p: new Vec3(0, 0, -hz * 0.95), r: tipR });
    }
    inertiaForShape(this.shape, d, this.baseMass, this._inertia);

    // Parallel-axis contributions from attached point masses
    let totalMass = this.baseMass;
    const e = this._inertia.e;
    for (const am of this.attachedMasses) {
      const { mass: m, point: p } = am;
      totalMass += m;
      const x = p.x, y = p.y, z = p.z;
      e[0] += m * (y * y + z * z); e[1] -= m * x * y;             e[2] -= m * x * z;
      e[3] -= m * x * y;           e[4] += m * (x * x + z * z);   e[5] -= m * y * z;
      e[6] -= m * x * z;           e[7] -= m * y * z;             e[8] += m * (x * x + y * y);
    }

    this.rigidBody.setMass(totalMass);
    this.rigidBody.setInertia(this._inertia);
    this.rigidBody.updateDerived();
    this._buildBodyPanels();
  }

  setMass(m) {
    this.baseMass = m;
    this.recalculate();
  }

  setShape(shape, dimensions) {
    this.shape = shape;
    this.dimensions = dimensions.slice();
    this.recalculate();
  }

  setAeroProfile(profileId) {
    this.aeroProfile = profileId;
    this._buildBodyPanels();
  }

  // Build BET panels capturing the segment's projected areas. The lifting
  // (±y) and side (±x) panels are split into fore and aft halves so the body
  // produces physically correct weathercock moments and rotational damping —
  // a fuselage's side area ahead of vs. behind the CG is what makes it
  // directionally stable, and a single central panel can't represent that.
  _buildBodyPanels() {
    this.bodyPanels.length = 0;
    if (this.noBodyPanels) return;
    const airfoil = AirfoilData.get(this.aeroProfile);
    const d = this.dimensions;

    let ex, ey, ez; // half-extents per axis
    switch (this.shape) {
      case 'ellipsoid': ex = d[0]; ey = d[1]; ez = d[2]; break;
      case 'capsule':   ex = d[0]; ey = d[0]; ez = d[0] + d[1]; break;
      case 'box':       ex = d[0]; ey = d[1]; ez = d[2]; break;
      case 'plate':     ex = d[1] * 0.5; ey = 0.002; ez = d[0] * 0.5; break;
      default:          ex = ey = ez = 0.05;
    }

    // Ellipse-area correction for non-box shapes (π/4 of bounding rectangle)
    const k = this.shape === 'box' ? 1.0 : Math.PI / 4;

    // Frontal panel (flow along z): single central strip, area ~ x·y
    this.bodyPanels.push(new FluidSurface({
      bodyPoint: new Vec3(0, 0, 0),
      chordDir: new Vec3(0, 0, 1),
      spanDir: new Vec3(1, 0, 0),
      chord: 2 * ez, span: (2 * ex) * (2 * ey) * k / (2 * ez + 1e-9),
      airfoil,
    }));
    // Lifting panels (±y projected area ~ x·z): fore + aft halves
    for (const zOff of [-ez * 0.5, ez * 0.5]) {
      this.bodyPanels.push(new FluidSurface({
        bodyPoint: new Vec3(0, 0, zOff),
        chordDir: new Vec3(0, 0, 1),
        spanDir: new Vec3(1, 0, 0),
        chord: ez, span: 2 * ex * k,
        airfoil,
      }));
    }
    // Side panels (±x projected area ~ y·z): fore + aft halves
    for (const zOff of [-ez * 0.5, ez * 0.5]) {
      this.bodyPanels.push(new FluidSurface({
        bodyPoint: new Vec3(0, 0, zOff),
        chordDir: new Vec3(0, 0, 1),
        spanDir: new Vec3(0, 1, 0),
        chord: ez, span: 2 * ey * k,
        airfoil,
      }));
    }
  }

  serialize() {
    const rb = this.rigidBody;
    return {
      id: this.id,
      name: this.name,
      shape: this.shape,
      dimensions: this.dimensions,
      mass: rb.mass,
      aeroProfile: this.aeroProfile,
      color: this.color,
      position: [rb.position.x, rb.position.y, rb.position.z],
      orientation: [rb.orientation.w, rb.orientation.x, rb.orientation.y, rb.orientation.z],
    };
  }
}
