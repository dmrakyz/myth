import { Vec3 } from '../math/Vec3.js';
import { forceLimitScale } from './ForceLimiter.js';
import { AirfoilData } from './AirfoilData.js';
import { lerp } from '../math/MathUtils.js';

// One Blade Element Theory strip. Universal: wings, feathers, fins, tail
// surfaces, and auto-generated body panels all use this class — only the
// airfoil profile and geometry differ. Works in any fluid medium (air/water)
// because density and flow are queried per-strip per-substep.
//
// The section model is SEMI-UNSTEADY, not quasi-steady: on top of the table
// coefficients it carries
//   • added-mass reaction      — the inertia of the fluid the chord drags
//     with it, m_a = ρ·π·(c/2)²·span, opposing normal acceleration
//   • rotational (Kramer) lift — ΔCl = π·α̇·c/(2V) from pitch rate
//   • circulatory lag          — Wagner-style first-order buildup of bound
//     circulation (½ instantaneous + ½ lagged over ~2 chord lengths)
//   • stall hysteresis         — separation fast, reattachment slow, with
//     both onset and recovery scaled by how unsteady the local flow is
// These are the leading-order terms a flapping wing lives on; without them
// big-amplitude strokes produce drag instead of lift.
//
// Geometry (parent body frame):
//   bodyPoint — strip aerodynamic center
//   chordDir  — unit chord direction (leading edge → trailing edge)
//   spanDir   — unit span direction
//   normal implied: chordDir × spanDir
const worldPoint = new Vec3();
const chordW = new Vec3();
const spanW = new Vec3();
const normalW = new Vec3();
const flow = new Vec3();
const vel = new Vec3();
const vPerp = new Vec3();
const liftDir = new Vec3();
const dragDir = new Vec3();
const force = new Vec3();
const tmp = new Vec3();

export class FluidSurface {
  constructor({
    bodyPoint = new Vec3(),
    chordDir = new Vec3(0, 0, 1),
    spanDir = new Vec3(1, 0, 0),
    chord = 0.1,
    span = 0.1,
    airfoil,
    camberAngle = 0,   // built-in incidence/twist about span axis (radians)
    inducedDragK = 0.06,  // Cdi = K·Cl², K ≈ 1/(π·e·AR); tables hold profile drag only
  }) {
    this.bodyPoint = bodyPoint.clone();
    this.chordDir = chordDir.clone(); Vec3.norm(this.chordDir, this.chordDir);
    this.spanDir = spanDir.clone();   Vec3.norm(this.spanDir, this.spanDir);
    this.chord = chord;
    this.span = span;
    this.airfoil = airfoil;
    this.camberAngle = camberAngle;
    this.inducedDragK = inducedDragK;

    // Finite-wing lift-slope factor (3D downwash correction + tip loss),
    // set by applyPlanform() from the owning wing's real aspect ratio.
    // 2D tables assume an infinite wing; a real wing's trailing vortices
    // induce downwash that reduces the effective lift slope to ~AR/(AR+2).
    this.clScale = 1;

    // Leading-edge-vortex gain: delayed stall on a rapidly plunging strip
    // raises attainable lift beyond the static table. Cl is scaled by
    // (1 + gain·u) where u is the fraction of the apparent wind contributed
    // by the strip's own motion (u ≈ 0 in a glide, so this is inert outside
    // flapping). Added mass and rotational lift are modeled explicitly below
    // and are NOT part of this gain. Set on wing strips by presets.
    this.unsteadyGain = 0;

    // Semi-unsteady state (per strip, persists across substeps)
    this._vnPrev = 0;       // fluid-relative normal velocity (added mass)
    this._alphaPrev = 0;    // previous α (rotational lift)
    this._alphaDotF = 0;    // low-passed α̇
    this._clLag = 0;        // lagged circulatory lift (Wagner buildup)
    this._hasPrev = false;  // history valid (false after rest / first call)

    // Runtime-controllable extra pitch about span axis (feather rachis
    // rotation, wing twist control). Applied in addition to camberAngle.
    this.pitchOffset = 0;

    // Stall hysteresis state (0 = attached, 1 = fully separated). Separation
    // sets in fast when α leaves the table's attached range; reattachment is
    // slow and only begins once α has dropped well below the stall angle —
    // recovering from a stall costs time and altitude, as it should.
    this.stallState = 0;

    // Telemetry (read by HUD / debug renderer after each substep)
    this.lastAlpha = 0;
    this.lastForce = new Vec3();
    this.lastWorldPoint = new Vec3();
    this.lastDynPressure = 0;
    this.lastLoad = 0; // |force| / (q·A) normalized-ish for shader tint
  }

  // Compute and apply aerodynamic force on parentBody. Returns |force|.
  // dt drives the unsteady terms and the stability force limiter.
  computeForce(parentBody, medium, dt = 1 / 240) {
    parentBody.localToWorld(this.bodyPoint, worldPoint);

    // Resolve strip frame to world
    parentBody.localDirToWorld(this.chordDir, chordW);
    parentBody.localDirToWorld(this.spanDir, spanW);

    // Apply pitch (camber + runtime offset) by rotating chord about span
    const pitch = this.camberAngle + this.pitchOffset;
    if (pitch !== 0) {
      // Rodrigues rotation of chordW about spanW
      const c = Math.cos(pitch), s = Math.sin(pitch);
      Vec3.cross(spanW, chordW, tmp);
      const d = Vec3.dot(spanW, chordW);
      chordW.x = chordW.x * c + tmp.x * s + spanW.x * d * (1 - c);
      chordW.y = chordW.y * c + tmp.y * s + spanW.y * d * (1 - c);
      chordW.z = chordW.z * c + tmp.z * s + spanW.z * d * (1 - c);
    }

    Vec3.cross(chordW, spanW, normalW);
    Vec3.norm(normalW, normalW);

    // Local fluid-relative velocity: v_body_point - v_fluid
    parentBody.pointVelocity(worldPoint, vel);
    medium.flow(worldPoint, flow);
    Vec3.sub(vel, flow, vel);

    // Project out the spanwise component (BET assumption: spanwise flow
    // doesn't generate section lift)
    const spanComp = Vec3.dot(vel, spanW);
    Vec3.addScaled(vel, spanW, -spanComp, vPerp);

    const vMag = Vec3.len(vPerp);
    this.lastWorldPoint.copy(worldPoint);
    if (vMag < 0.01) {
      Vec3.zero(this.lastForce);
      this.lastAlpha = 0;
      this.lastLoad = 0;
      this._hasPrev = false;   // history is stale after a rest
      this._clLag = 0;
      return 0;
    }

    // Angle of attack measured between the chord line and the apparent wind
    // w = -vPerp. Positive alpha = wind striking the normal-side (underside)
    // of the strip → positive lift along the strip normal.
    const wChord = -Vec3.dot(vPerp, chordW);
    const wNormal = -Vec3.dot(vPerp, normalW);
    const alpha = Math.atan2(wNormal, wChord);
    this.lastAlpha = alpha;

    if (this.debugLog) {
      console.log(`  [strip] vel=(${vel.x.toFixed(2)},${vel.y.toFixed(2)},${vel.z.toFixed(2)}) ` +
        `vPerp=(${vPerp.x.toFixed(2)},${vPerp.y.toFixed(2)},${vPerp.z.toFixed(2)}) ` +
        `chordW=(${chordW.x.toFixed(2)},${chordW.y.toFixed(2)},${chordW.z.toFixed(2)}) ` +
        `spanW=(${spanW.x.toFixed(2)},${spanW.y.toFixed(2)},${spanW.z.toFixed(2)}) ` +
        `normW=(${normalW.x.toFixed(2)},${normalW.y.toFixed(2)},${normalW.z.toFixed(2)}) ` +
        `pitch=${((this.camberAngle + this.pitchOffset) * 57.3).toFixed(1)}° α=${(alpha * 57.3).toFixed(1)}°`);
    }

    const rho = medium.density(worldPoint);
    const qDyn = 0.5 * rho * vMag * vMag;
    this.lastDynPressure = qDyn;
    const area = this.chord * this.span;

    // Unsteadiness u: fraction of the apparent wind contributed by the
    // strip's rotation about its parent body's CG (flap plunge). ~0 in a
    // glide; approaches 1 when the strip's own motion dominates.
    Vec3.sub(worldPoint, parentBody.position, tmp);
    Vec3.cross(parentBody.angularVelocity, tmp, tmp);
    const u = Math.min(1, Vec3.len(tmp) / (vMag + 0.1));

    // ── Rotational (Kramer) lift: pitch rate adds circulation ────────────
    // ΔCl = π·α̇·c/(2V). α̇ from a wrapped finite difference, low-passed at
    // ~100 rad/s to reject substep noise. This is what lets a pronating
    // downstroke carry lift through rapid twist, and it damps pitch flutter.
    let dAlpha = alpha - this._alphaPrev;
    if (dAlpha > Math.PI) dAlpha -= 2 * Math.PI;
    else if (dAlpha < -Math.PI) dAlpha += 2 * Math.PI;
    const alphaDotRaw = this._hasPrev ? dAlpha / dt : 0;
    this._alphaDotF += (alphaDotRaw - this._alphaDotF) * Math.min(1, dt * 100);
    this._alphaPrev = alpha;
    const clRot = Math.PI * this._alphaDotF * this.chord / (2 * vMag);

    let Cl = this.clScale * this.airfoil.Cl(alpha)
      + Math.max(-0.6, Math.min(0.6, clRot));
    // Induced drag uses the BOUND circulation (base Cl only). LEV is a
    // transient leading-edge vortex — it boosts instantaneous Cl without
    // proportionally increasing the trailing-vortex-induced drag that
    // comes from the time-mean spanwise loading.
    let Cd = this.airfoil.Cd(alpha) + this.inducedDragK * Cl * Cl;
    // Leading-edge-vortex augmentation on plunge-dominated flow: see field
    if (this.unsteadyGain > 0) Cl *= 1 + this.unsteadyGain * u;

    // ── Stall hysteresis with dynamic-stall delay ─────────────────────────
    // α beyond the table's attached range separates the boundary layer in
    // ~40 ms. Dropping the nose does NOT instantly restore clean flow: the
    // strip stays on degraded post-stall coefficients until α falls below
    // ~70% of the stall angle, then reattaches over ~0.35 s. BOTH onset and
    // recovery scale with unsteadiness u: the leading-edge vortex of dynamic
    // stall keeps plunging flow effectively attached past static stall, and
    // the flow state resets at every stroke reversal rather than carrying a
    // steady-flow reattachment delay through the flap cycle. Profiles
    // tabulated over the full ±180° (blunt bodies) never leave their range
    // and skip all of this.
    const aMaxT = this.airfoil.alphaMax, aMinT = this.airfoil.alphaMin;
    const beyond = alpha > aMaxT || alpha < aMinT;
    if (beyond || this.stallState > 0) {
      if (beyond) {
        // LEV keeps flow attached well past static stall on actively flapping
        // strips. The suppression factor scales with unsteadyGain: at gain=1.8
        // and u≥0.4 the wing never enters dynamic stall (biologically validated
        // for birds at St≈0.25–0.45). Strips without LEV physics (gain=0) use
        // the conservative 1.6 factor from steady-flow experiments.
        const levFactor = this.unsteadyGain > 0 ? 1.6 + this.unsteadyGain * 0.5 : 1.6;
        const grow = Math.max(0, 1 - levFactor * u);
        this.stallState = Math.min(1, this.stallState + (dt / 0.04) * grow);
      } else if (alpha < aMaxT * 0.7 && alpha > aMinT * 0.7) {
        this.stallState = Math.max(0, this.stallState - (dt / 0.35) * (1 + 10 * u));
      }
      if (this.stallState > 0) {
        const sepCl = AirfoilData.flatPlateCl(alpha);
        const sepCd = AirfoilData.flatPlateCd(alpha);
        Cl = lerp(Cl, sepCl, this.stallState);
        Cd = lerp(Cd, sepCd, this.stallState);
      }
    }

    // ── Circulatory lag (Wagner): bound circulation can't jump ───────────
    // A step change in α reaches ~½ of its final lift instantly, the rest
    // builds as the wing travels ~2 chord lengths. Modeled as ½ direct +
    // ½ first-order lag with τ = 2c/V. Also smooths substep Cl flicker.
    const tauW = 2 * this.chord / vMag;
    this._clLag += (Cl - this._clLag) * Math.min(1, dt / Math.max(tauW, dt));
    if (!this._hasPrev) this._clLag = Cl;
    Cl = 0.5 * Cl + 0.5 * this._clLag;

    // Drag along the apparent wind w = -vPerp; lift = ŵ × span, which lies
    // in the chord-normal plane perpendicular to the flow. The sign works out
    // for both wing sides: a mirrored span flips both normalW and liftDir,
    // and alpha flips with them, so lift always acts on the correct side.
    Vec3.scale(vPerp, -1 / vMag, dragDir);
    Vec3.cross(dragDir, spanW, liftDir);
    Vec3.norm(liftDir, liftDir);

    const L = qDyn * area * Cl;
    const D = qDyn * area * Cd;

    Vec3.scale(liftDir, L, force);
    Vec3.addScaled(force, dragDir, D, force);

    // ── Added mass: the fluid's own inertia ──────────────────────────────
    // A chord accelerating normal to itself drags a cylinder of fluid with
    // it, m_a = ρ·π·(c/2)²·span. The reaction opposes normal acceleration —
    // it loads the downstroke, gives free force back at stroke reversal,
    // and resists the rapid normal accelerations of pitch flutter.
    const vN = Vec3.dot(vel, normalW);
    if (this._hasPrev) {
      let aN = (vN - this._vnPrev) / dt;
      if (aN > 400) aN = 400; else if (aN < -400) aN = -400;
      const mA = rho * Math.PI * 0.25 * this.chord * this.chord * this.span;
      Vec3.addScaled(force, normalW, -mA * aN, force);
    }
    this._vnPrev = vN;
    this._hasPrev = true;

    // Aeroelastic-relief limiter: prevents explicit-integration divergence
    // on very light parts (see ForceLimiter.js)
    const scale = forceLimitScale(parentBody, worldPoint, force, vMag, dt);
    if (scale < 1) Vec3.scale(force, scale, force);

    parentBody.applyForce(force, worldPoint);

    this.lastForce.copy(force);
    this.lastLoad = Math.min(1, Math.abs(L) / (qDyn * area * 1.5 + 1e-9));
    return Vec3.len(force);
  }
}
