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
  } = {}) {
    this.id = `seg_${nextSegmentId++}`;
    this.name = name;
    this.shape = shape;
    this.dimensions = dimensions.slice();
    this.aeroProfile = aeroProfile;
    this.color = color;

    this.rigidBody = new RigidBody({ mass, position, orientation });
    this.bodyPanels = [];   // auto FluidSurfaces
    this._inertia = new Mat3();

    this.recalculate();
  }

  get mass() { return this.rigidBody.mass; }

  recalculate() {
    const d = this.dimensions;
    this.volume = volumeForShape(this.shape, d);
    this.boundingRadius = boundingRadiusForShape(this.shape, d);
    inertiaForShape(this.shape, d, this.rigidBody.mass, this._inertia);
    this.rigidBody.setInertia(this._inertia);
    this.rigidBody.updateDerived();
    this._buildBodyPanels();
  }

  setMass(m) {
    this.rigidBody.setMass(m);
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

  // Build three orthogonal panels capturing projected areas along x, y, z.
  // Each panel is a BET strip whose chord/span correspond to the segment's
  // extents in the plane perpendicular to that axis.
  _buildBodyPanels() {
    this.bodyPanels.length = 0;
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

    // Panel facing ±z (flow along z): chord along z, span along x, area ~ x·y
    this.bodyPanels.push(new FluidSurface({
      bodyPoint: new Vec3(0, 0, 0),
      chordDir: new Vec3(0, 0, 1),
      spanDir: new Vec3(1, 0, 0),
      chord: 2 * ez, span: (2 * ex) * (2 * ey) * k / (2 * ez + 1e-9),
      airfoil,
    }));
    // Panel facing ±y: chord along z, span along x (lifting orientation),
    // area ~ x·z — this is the panel that gives a torso crossflow lift
    this.bodyPanels.push(new FluidSurface({
      bodyPoint: new Vec3(0, 0, 0),
      chordDir: new Vec3(0, 0, 1),
      spanDir: new Vec3(1, 0, 0),
      chord: 2 * ez, span: 2 * ex * k,
      airfoil,
    }));
    // Panel facing ±x: chord along z, span along y, area ~ y·z
    this.bodyPanels.push(new FluidSurface({
      bodyPoint: new Vec3(0, 0, 0),
      chordDir: new Vec3(0, 0, 1),
      spanDir: new Vec3(0, 1, 0),
      chord: 2 * ez, span: 2 * ey * k,
      airfoil,
    }));
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
