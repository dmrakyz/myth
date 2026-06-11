import { clamp, lerp, TWO_PI } from '../math/MathUtils.js';
import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';

const FWD = new Vec3(0, 0, -1), UP = new Vec3(0, 1, 0), RIGHT = new Vec3(1, 0, 0);
const fwdW = new Vec3(), upW = new Vec3(), rightW = new Vec3();
const boostForce = new Vec3();

// Drives muscle target angles with periodic waveforms shaped by flight input.
// Each muscle gets a pattern:
//   { frequency, amplitude, phase, restAngle, waveform,
//     flapScale,   — how much flapRate input modulates amplitude (0..1)
//     pitchBias, rollBias, yawBias — how control inputs shift restAngle }
//
// Asymmetric roll/yaw control emerges from biasing left/right wing patterns
// in opposite directions — exactly how birds steer.
export class FlappingController {
  constructor(creature) {
    this.creature = creature;
    this.patterns = new Map();   // muscleId → pattern
    this.time = 0;
    this.globalFrequencyScale = 1;
    this.currentFrequency = 0;   // telemetry for HUD

    // Vestibular reflex gains — birds are aerodynamically unstable and
    // stabilize actively; without this the airframe tumbles. Signals are
    // attitude/rate errors of the root body; each muscle pattern declares
    // how strongly it responds (stabRoll/stabPitch/stabYaw).
    this.stabilize = true;
    this.gains = {
      rollP: 2.6, rollD: 0.45,     // roll angle / roll rate
      pitchP: 0.8, pitchD: 0.04,   // pitch attitude / rate (D small: torso ω noisy due to wing reactions)
      yawD: 0.3,                   // yaw rate damping
      yawToRoll: 1.6,              // banks against a steady heading drift (turn coordinator)
      vyDamp: 0.035,               // pitch-setpoint feedback on vertical speed (phugoid damper)
      slipRoll: 0,                 // sideslip velocity → roll correction (tuned per preset)
    };
    this.trimPitch = 0.05;         // trim AoA above flight path (rad); wing camber adds ~7° more
    this.bankCommand = 0.6;        // max commanded bank angle at full stick (rad, ~35°)

    // Active rudder: a vertical tail surface whose deflection about its
    // vertical span axis is servo-driven — yaw-rate damping plus sideslip
    // weathercocking far stronger than the passive fin, and direct yaw-stick
    // authority. Real birds do this by twisting the spread tail. setRudder().
    this.rudder = null;            // { strip, yawGain, slipGain, cmdGain, max }

    // Low-pass filter on the roll correction. Flapping injects roll-rate
    // noise at wingbeat frequency; an unfiltered reflex thrashes the wrists
    // asymmetrically every beat (one hand folds while the other extends — looks
    // like one wing flapping). The spiral mode it must fight is far slower than
    // the wingbeat, so a ~1.2 Hz filter keeps stability and kills the thrash.
    this.rollLpf = 5;              // cutoff (rad/s)
    this._sRollF = 0;

    // Active wing twist (pronation/supination through the stroke): registered
    // via addWingTwist(). Each strip's pitchOffset servos to keep its measured
    // AoA inside the attached range — the leading edge pitches down into the
    // relative wind on the downstroke (lift stays attached and tilts forward
    // into thrust) and up on the upstroke (kills negative lift). This is the
    // wing-twist control real birds use; it's inert in a glide where AoA
    // already sits in range.
    this.twists = [];

    // Unsteady-lift augmentation (N at full flap). Quasi-steady blade-element
    // theory underestimates flapping force because it ignores the unsteady
    // mechanisms real flapping exploits — delayed-stall / leading-edge vortex,
    // rotational (Kramer) lift, and added-mass reaction — which together can
    // roughly double peak force on a downstroke. We model their cycle-averaged
    // net as a body-up force scaled by flap power, applied at the CG so it adds
    // genuine climb authority without injecting any roll/yaw asymmetry. This is
    // what lets powered flight climb while a pure glide sinks.
    this.flapBoost = 1.7;
    this.climbRate = 1.0;          // target climb speed for adaptive boost (m/s)
    this.flapBoostGain = 0.6;      // boost ramps up when vy < climbRate, down when above
  }

  // Register active twist for a Wing (BET strips) or a FeatherArray.
  // aMin/aMax bound the strip AoA (rad); relax is the per-substep correction
  // fraction; max caps total commanded twist.
  setRudder(strip, { yawGain = 0, slipGain = 0, cmdGain = 0, max = 0.45 } = {}) {
    this.rudder = { strip, yawGain, slipGain, cmdGain, max };
  }

  addWingTwist(wing, { aMin = -0.12, aMax = 0.22, relax = 0.25, max = 0.5 } = {}) {
    this.twists.push({ feathers: wing.feathers || null, strips: wing.strips || null, aMin, aMax, relax, max });
  }

  setPattern(muscleId, pattern) {
    this.patterns.set(muscleId, {
      frequency: 3,
      amplitude: 0.6,
      phase: 0,
      restAngle: 0,
      waveform: 'sine',
      flapScale: 1,
      pitchBias: 0,
      rollBias: 0,
      yawBias: 0,
      stabRoll: 0,
      stabPitch: 0,
      stabYaw: 0,
      ...pattern,
    });
  }

  _waveValue(waveform, phase) {
    switch (waveform) {
      case 'sine': return Math.sin(phase);
      case 'triangle': {
        const t = (phase / TWO_PI) % 1;
        return 4 * Math.abs(t - 0.5) - 1;
      }
      case 'downbeat': {
        // Fast downstroke, slow upstroke — closer to real bird kinematics
        const t = ((phase / TWO_PI) % 1 + 1) % 1;
        return t < 0.4
          ? Math.cos(t / 0.4 * Math.PI)          // 1 → −1 fast
          : Math.cos(Math.PI + (t - 0.4) / 0.6 * Math.PI); // −1 → 1 slow
      }
      case 'foldup': {
        // Wrist flexion synchronized with the 'downbeat' cycle: a slight
        // trailing extension whip through the downstroke (t<0.4), then the
        // hand folds in through the upstroke — how birds shorten the wing on
        // recovery to cut negative lift.
        const t = ((phase / TWO_PI) % 1 + 1) % 1;
        return t < 0.4
          ? -0.25 * Math.sin(t / 0.4 * Math.PI)
          : Math.sin((t - 0.4) / 0.6 * Math.PI);
      }
      default: return Math.sin(phase);
    }
  }

  update(t, dt, input) {
    this.time = t;
    const flap = clamp(input.flapRate, 0, 1);

    // Reflex stabilization signals from the root body
    let sRoll = 0, sPitch = 0, sYaw = 0;
    const root = this.creature.root;
    if (this.stabilize && root) {
      const rb = root.rigidBody;
      Quat.rotateVec(rb.orientation, FWD, fwdW);
      Quat.rotateVec(rb.orientation, UP, upW);
      Quat.rotateVec(rb.orientation, RIGHT, rightW);
      const w = rb.angularVelocity;
      const g = this.gains;

      const rollAngle = Math.atan2(rightW.y, upW.y);          // + = right wing up
      const pitchAngle = Math.asin(clamp(fwdW.y, -1, 1));     // + = nose up
      const p = Vec3.dot(w, fwdW);    // roll rate
      const q = Vec3.dot(w, rightW);  // pitch rate
      const r = Vec3.dot(w, upW);     // yaw rate

      // Pitch is regulated relative to the FLIGHT PATH, not the horizon:
      // attitude-hold stalls during descent (path tilts down while attitude
      // stays level, so AoA grows unbounded). Referencing the velocity vector
      // makes the reflex an AoA regulator — the bird noses down into the
      // relative wind when it sinks, exactly like a statically stable glider.
      const v = rb.velocity;
      const hSpeed = Math.hypot(v.x, v.z);
      let fpa = 0;
      if (Math.hypot(hSpeed, v.y) > 2) fpa = Math.atan2(v.y, hSpeed);
      const aoaProxy = pitchAngle - fpa;

      // Pilot pitch input shifts the AoA setpoint (fly-by-wire) rather than
      // fighting the reflex with raw tail deflection; +0.10 rad keeps the
      // commanded AoA just under stall at full stick.
      // −vyDamp·v_y damps the phugoid (the slow speed/altitude porpoise the
      // AoA reflex can't see). Climb authority now comes from flapBoost (a
      // force), not from this setpoint, so damping v_y no longer fights the
      // climb — it just smooths it.
      const trim = this.trimPitch + 0.10 * clamp(input.pitchUp, -1, 1)
        - g.vyDamp * clamp(v.y, -4, 4);
      // Yaw rate biases the roll loop so a slow heading drift is met with an
      // opposing bank instead of accumulating into a spiral. Pilot roll input
      // bypasses this (commanded turns shouldn't be fought).
      const yawCorr = input.rollLeft ? 0 : g.yawToRoll * r;
      // Pilot roll input commands a BANK ANGLE through the same reflex that
      // holds the bird level — not a raw wrist bias fighting that reflex. The
      // stabilizer tracks any setpoint it can hold at zero, so roll authority
      // works identically gliding or flapping, with the correct sign by
      // construction (+rollLeft → +setpoint → right wing up → bank left).
      const rollSet = this.bankCommand * clamp(input.rollLeft, -1, 1);
      // Sideslip: lateral airspeed in the body frame. The spiral mode starts
      // as a slow slip that dihedral converts into roll; sensing it directly
      // (like a bird's flow-sensing feathers) catches the departure before
      // the bank builds up.
      const vSide = Vec3.dot(v, rightW);
      sRoll = clamp(-g.rollP * (rollAngle - rollSet) - g.rollD * p - yawCorr
        - g.slipRoll * clamp(vSide, -3, 3), -0.8, 0.8);
      sPitch = clamp(-g.pitchP * (aoaProxy - trim) - g.pitchD * q, -0.7, 0.7);
      sYaw = clamp(-g.yawD * r, -0.5, 0.5);

      // Active rudder servo (tail twist): yaw-rate damping + weathercock +
      // pilot yaw command, written straight onto the fin strip's pitchOffset.
      if (this.rudder) {
        const rd = this.rudder;
        rd.strip.pitchOffset = clamp(
          rd.yawGain * r + rd.slipGain * clamp(vSide, -4, 4)
            + rd.cmdGain * clamp(input.yawLeft, -1, 1),
          -rd.max, rd.max,
        );
      }
    }
    // Low-pass on the roll correction (see constructor note)
    this._sRollF += (sRoll - this._sRollF) * Math.min(1, dt * this.rollLpf);
    sRoll = this._sRollF;

    // Apply the unsteady-lift augmentation at the CG, directed up-and-forward —
    // the true direction of a flapping bird's net force. The vertical part
    // climbs; the forward part is thrust that holds airspeed during the climb
    // (without it, climbing bleeds speed and the bird porpoises). Built from
    // world-up + the body's horizontal heading so it never couples to pitch
    // attitude, and applied at the CG so it adds no roll/yaw — no spiral.
    if (this.flapBoost > 0 && flap > 0 && root) {
      const rb = root.rigidBody;
      if (!this.stabilize) Quat.rotateVec(rb.orientation, FWD, fwdW);
      const hx = fwdW.x, hz = fwdW.z;
      const hlen = Math.hypot(hx, hz) || 1;
      const vy = rb.velocity.y;
      const f = Math.max(0.5, this.flapBoost + this.flapBoostGain * clamp(this.climbRate - vy, -3, 3)) * flap;
      // direction = normalize(worldUp + 0.5·heading); ~63% up, ~37% forward
      let dx = 0.5 * hx / hlen, dy = 1.0, dz = 0.5 * hz / hlen;
      const dl = Math.hypot(dx, dy, dz);
      boostForce.set(dx / dl * f, dy / dl * f, dz / dl * f);
      rb.applyCentralForce(boostForce);
    }

    this.currentFrequency = 0;
    for (const [muscleId, pat] of this.patterns) {
      const muscle = this.creature.muscles.get(muscleId);
      if (!muscle) continue;

      // flapRate scales beat frequency from a slow idle up to the pattern's
      // rated frequency — not beyond, so a medium/large bird never buzzes.
      const freq = pat.frequency * this.globalFrequencyScale * lerp(0.5, 1.0, flap);
      // Telemetry: report the wingbeat (highest active oscillation, zero amp = not beating)
      if (pat.frequency > 0 && pat.amplitude * flap * pat.flapScale !== 0) {
        this.currentFrequency = Math.max(this.currentFrequency, freq);
      }

      // Amplitude scales with flap input; at zero input wings hold a glide
      // pose exactly (any residual oscillation pumps energy into the glide)
      const amp = pat.amplitude * flap * pat.flapScale;

      const phase = TWO_PI * freq * t + pat.phase;
      const wave = this._waveValue(pat.waveform, phase);

      const bias =
        pat.pitchBias * input.pitchUp +
        pat.rollBias * input.rollLeft +
        pat.yawBias * input.yawLeft +
        pat.stabRoll * sRoll +
        pat.stabPitch * sPitch +
        pat.stabYaw * sYaw;

      // Brake: spread/extend toward max rest angle
      const brakeShift = (input.brake || 0) * 0.4;

      muscle.setTargetAngle(pat.restAngle + bias + brakeShift + amp * wave);
    }

    // Active twist: servo each surface's commanded pitch to keep last
    // measured AoA attached. Excess above aMax (downstroke) pronates; below
    // aMin (upstroke) supinates. With no excess the twist relaxes to zero.
    // Feathers keep their passive rachis pitch; the command stacks on top.
    const decay = Math.min(1, dt * 8);
    for (let i = 0; i < this.twists.length; i++) {
      const tw = this.twists[i];
      if (tw.strips) {
        for (let s = 0; s < tw.strips.length; s++) {
          const strip = tw.strips[s];
          const a = strip.lastAlpha;
          const excess = a > tw.aMax ? a - tw.aMax : a < tw.aMin ? a - tw.aMin : 0;
          let po = strip.pitchOffset;
          if (excess !== 0) po -= tw.relax * excess;
          else po -= po * decay;
          strip.pitchOffset = clamp(po, -tw.max, tw.max);
        }
      } else if (tw.feathers) {
        for (let s = 0; s < tw.feathers.length; s++) {
          const f = tw.feathers[s];
          const a = f.surface.lastAlpha;
          const excess = a > tw.aMax ? a - tw.aMax : a < tw.aMin ? a - tw.aMin : 0;
          let po = f.controlPitch;
          if (excess !== 0) po -= tw.relax * excess;
          else po -= po * decay;
          f.controlPitch = clamp(po, -tw.max, tw.max);
        }
      }
    }
  }
}
