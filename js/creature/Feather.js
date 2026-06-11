import { Vec3 } from '../math/Vec3.js';
import { FluidSurface } from '../fluid/FluidSurface.js';
import { clamp } from '../math/MathUtils.js';

// One feather: a BET strip with passive pitch about its rachis (span axis at
// the leading edge). The aerodynamic center sits at quarter chord behind the
// rachis, so normal force produces a feathering moment that rotates the
// feather to relieve load — the passive pitch adaptation real feathers
// exhibit during the flap cycle.
//
// The torsional dynamics are QUASI-STATIC: a feather's torsional natural
// frequency (~200 Hz) is far above flap frequencies, so it tracks its moment
// equilibrium  k·(θ−θ₀) = τ_aero(θ)  essentially instantly. Solving the
// equilibrium algebraically (with relaxation for the aero feedback) is both
// more physical at this timescale and unconditionally stable — explicitly
// integrating the stiff ODE at 240 Hz produces a substep-rate limit cycle.
const normalW = new Vec3();
const chordW = new Vec3();
const spanW = new Vec3();

export class Feather {
  constructor({
    bodyPoint, chordDir, spanDir, chord, span, airfoil,
    restTwist = 0,
    torsionalStiffness = 0.5,  // N·m/rad
    torsionalDamping = 0.05,   // kept for serialization compat (unused)
    maxTwist = 0.6,            // rad
  }) {
    this.surface = new FluidSurface({ bodyPoint, chordDir, spanDir, chord, span, airfoil });
    this.restTwist = restTwist;
    this.k = torsionalStiffness;
    this.maxTwist = maxTwist;

    this.pitch = restTwist;
    // Active pitch command (wing-twist control) added on top of the passive
    // rachis equilibrium; written by FlappingController's twist servo.
    this.controlPitch = 0;
    this.surface.pitchOffset = this.pitch;
  }

  computeForce(parentBody, medium, dt) {
    const mag = this.surface.computeForce(parentBody, medium, dt);

    // Feathering moment: normal component of aero force × quarter-chord arm
    parentBody.localDirToWorld(this.surface.chordDir, chordW);
    parentBody.localDirToWorld(this.surface.spanDir, spanW);
    Vec3.cross(chordW, spanW, normalW);
    Vec3.norm(normalW, normalW);
    const Fn = Vec3.dot(this.surface.lastForce, normalW);
    const tauAero = -Fn * this.surface.chord * 0.25;

    // Quasi-static equilibrium with relaxation (feather relaxes toward
    // k·(θ−θ₀) = τ_aero over ~8 ms — fast but smooth)
    const target = clamp(
      this.restTwist + tauAero / this.k,
      this.restTwist - this.maxTwist,
      this.restTwist + this.maxTwist,
    );
    const lambda = Math.min(1, dt / 0.008);
    this.pitch += lambda * (target - this.pitch);
    this.surface.pitchOffset = this.pitch + this.controlPitch;
    return mag;
  }
}
