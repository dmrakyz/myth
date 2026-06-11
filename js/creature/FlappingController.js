import { clamp, lerp, TWO_PI } from '../math/MathUtils.js';
import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';

const FWD = new Vec3(0, 0, -1), UP = new Vec3(0, 1, 0), RIGHT = new Vec3(1, 0, 0);
const fwdW = new Vec3(), upW = new Vec3(), rightW = new Vec3();

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
      rollP: 1.8, rollD: 0.45,     // roll angle / roll rate
      pitchP: 0.8, pitchD: 0.04,   // pitch attitude / rate (D small: torso ω noisy due to wing reactions)
      yawD: 0.3,                   // yaw rate damping
      yawToRoll: 1.2,              // banks against a steady heading drift (turn coordinator)
    };
    this.trimPitch = 0.05;         // trim AoA above flight path (rad); wing camber adds ~7° more
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
      const trim = this.trimPitch + 0.10 * clamp(input.pitchUp, -1, 1);
      // Yaw rate biases the roll loop so a slow heading drift is met with an
      // opposing bank instead of accumulating into a spiral. Pilot roll input
      // bypasses this (commanded turns shouldn't be fought).
      const yawCorr = input.rollLeft ? 0 : g.yawToRoll * r;
      sRoll = clamp(-g.rollP * rollAngle - g.rollD * p - yawCorr, -0.6, 0.6);
      sPitch = clamp(-g.pitchP * (aoaProxy - trim) - g.pitchD * q, -0.7, 0.7);
      sYaw = clamp(-g.yawD * r, -0.5, 0.5);
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
  }
}
