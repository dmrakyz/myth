import { Vec3 } from '../math/Vec3.js';
import { FluidSurface } from '../fluid/FluidSurface.js';
import { clamp } from '../math/MathUtils.js';

// One feather: a BET strip with passive 1-DOF pitch dynamics about its rachis
// (span axis at the leading edge). The aerodynamic center sits at quarter
// chord behind the rachis, so normal force produces a feathering moment that
// rotates the feather to relieve load — the passive pitch adaptation real
// feathers exhibit during the flap cycle. Integrated explicitly per substep;
// the system is a stiff-ish spring but stable at 240 Hz with these params.
const normalW = new Vec3();
const chordW = new Vec3();
const spanW = new Vec3();

export class Feather {
  constructor({
    bodyPoint, chordDir, spanDir, chord, span, airfoil,
    restTwist = 0,
    torsionalStiffness = 0.5,  // N·m/rad
    torsionalDamping = 0.05,   // N·m·s/rad
    maxTwist = 0.6,            // rad
  }) {
    this.surface = new FluidSurface({ bodyPoint, chordDir, spanDir, chord, span, airfoil });
    this.restTwist = restTwist;
    this.k = torsionalStiffness;
    this.c = torsionalDamping;
    this.maxTwist = maxTwist;

    this.pitch = restTwist;
    this.pitchVel = 0;
    // Feather moment of inertia about rachis: thin plate, I = m·c²/3.
    // Feather mass ~ area · 0.05 kg/m² (vane density)
    const mass = chord * span * 0.05;
    this.inertia = Math.max(1e-7, mass * chord * chord / 3);

    this.surface.pitchOffset = this.pitch;
  }

  computeForce(parentBody, medium, dt) {
    const mag = this.surface.computeForce(parentBody, medium);

    // Feathering moment: normal component of aero force × quarter-chord arm.
    // Reconstruct strip normal in world to project the force.
    parentBody.localDirToWorld(this.surface.chordDir, chordW);
    parentBody.localDirToWorld(this.surface.spanDir, spanW);
    Vec3.cross(chordW, spanW, normalW);
    Vec3.norm(normalW, normalW);
    const Fn = Vec3.dot(this.surface.lastForce, normalW);
    const tauAero = -Fn * this.surface.chord * 0.25;

    // θ̈ = (τ_aero − k(θ−θ₀) − cθ̇) / I — semi-implicit Euler
    const tau = tauAero - this.k * (this.pitch - this.restTwist) - this.c * this.pitchVel;
    this.pitchVel += (tau / this.inertia) * dt;
    this.pitchVel = clamp(this.pitchVel, -50, 50);
    this.pitch += this.pitchVel * dt;

    const lo = this.restTwist - this.maxTwist, hi = this.restTwist + this.maxTwist;
    if (this.pitch < lo) { this.pitch = lo; if (this.pitchVel < 0) this.pitchVel = 0; }
    if (this.pitch > hi) { this.pitch = hi; if (this.pitchVel > 0) this.pitchVel = 0; }

    this.surface.pitchOffset = this.pitch;
    return mag;
  }
}
