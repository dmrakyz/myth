import { clamp, lerp, TWO_PI } from '../math/MathUtils.js';

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

    for (const [muscleId, pat] of this.patterns) {
      const muscle = this.creature.muscles.get(muscleId);
      if (!muscle) continue;

      const freq = pat.frequency * this.globalFrequencyScale * lerp(0.25, 1.25, flap);
      this.currentFrequency = freq;

      // Amplitude scales with flap input; at zero input wings hold a glide pose
      const amp = pat.amplitude * lerp(0.05, 1, flap * pat.flapScale);

      const phase = TWO_PI * freq * t + pat.phase;
      const wave = this._waveValue(pat.waveform, phase);

      const bias =
        pat.pitchBias * input.pitchUp +
        pat.rollBias * input.rollLeft +
        pat.yawBias * input.yawLeft;

      // Brake: spread/extend toward max rest angle
      const brakeShift = (input.brake || 0) * 0.4;

      muscle.setTargetAngle(pat.restAngle + bias + brakeShift + amp * wave);
    }
  }
}
