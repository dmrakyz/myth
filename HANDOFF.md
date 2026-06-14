# Handoff — Myth Bird Flight Physics

## Repo & Branch
- Repo: `dmrakyz/myth`, working directory `/home/user/myth`
- Branch: `claude/creature-flight-physics-sim-0y3gao`
- Current HEAD: `070babc` — "Fix pitch oscillation and spiral/circle heading drift"
- Run server: `python3 -m http.server` from repo root (required for GLSL `fetch()`)
- Run tests: `node test/flight_test.mjs`

---

## What the Sim Is

Browser-based physics playground for biologically realistic flapping-wing creatures. Every surface — wings, body, tail, feathers — generates aero forces via Blade Element Theory (BET). No Unity, no game engine; pure JS + Three.js + a custom RK4 6DOF rigid-body solver at 240 Hz.

Bird preset: ~0.36 kg, ~1.1m span gull. Torso → arm (shoulder hinge Z-axis) → hand (wrist hinge Z-axis). 5 secondary BET strips on each arm bone, 10 primary feathers on each hand (individual rigid plates with passive rachis pitch). All-moving tail for pitch, tail fin strip for yaw/sideslip weathercock.

Key files:
- `js/creature/presets/Bird.js` — all bird geometry, joints, muscles, controller patterns
- `js/creature/FlappingController.js` — sin waveform → muscle targets; pitch/roll/yaw stabilizers; active twist; wake capture
- `js/fluid/FluidSurface.js` — single BET strip: AoA computation, Cl/Cd lookup, stall model, Wagner lag, LEV augmentation
- `js/fluid/AirfoilData.js` — NACA 2412 / flatplate / naca0012 tables + post-stall blending
- `js/renderer/CreatureRenderer.js` — physics state → Three.js mesh transforms
- `test/flight_test.mjs` — 9 automated sub-tests (4 glide, 3 powered, 1 pitch, 1 roll)

---

## Current Test Results (all 9 pass, but two behaviours are broken)

```
GLIDE (flapRate=0, 8s from 40m at 8m/s):
  glide ratio 13.8 ✓  fwd>4m/s ✓  no dive runaway ✓  stays airborne ✓

POWERED (flapRate=1, 10s):
  final alt 40.1m (starts 40m — holding altitude, vy oscillates ±1.5m/s) ✓
  lat drift −10.9m at 10s  ← borderline (limit 15m, passes but nearly fails)

PITCH UP (flapRate=1, pitchUp=0.5, 6s):
  t=2s: alt=42m, spd=3.7m/s — bird zooms up, bleeds speed
  t=4s: vy=−5.5m/s, spd=10m/s — stall → dive  ← BROKEN in practice

PITCH DOWN (flapRate=1, pitchUp=−0.5, 6s):
  t=2s: vy=−9.5m/s — extreme dive rate  ← very aggressive

ROLL LEFT (flapRate=1, rollLeft=0.6, 8s):
  t=8s: lat=15.3m, spd=10.2m/s, vy=−3.5m/s — spiral dive  ← BROKEN in practice
```

Tests pass because thresholds are loose (glide ratio>2, alt>25m, lat<15m, lat>3m). Actual behaviour under aggressive input is broken.

---

## Bird.js Parameter State (070babc)

```js
// Shoulder
limits: { min: -1.2, max: 1.2 }          // ← commanded max is 1.40 — hits limit every upstroke
stiffness: 40, damping: 1.5, maxTorque: 12

// Wrist
limits: { min: -0.9, max: 0.9 }
stiffness: 8, damping: 0.8, maxTorque: 4

// Tail muscle
stiffness: 22, damping: 3.0, maxTorque: 3.5, restAngle: 0
limits: { min: -0.6, max: 0.6 }

// flapR / flapL patterns
frequency: 3.8, amplitude: ±1.1, restAngle: ±0.30
waveform: 'downbeat', stabRoll: -0.40, tuckAngle: ±0.30, brakeAngle: ±0.35
// NOTE: restAngle(0.30) + amplitude(1.1) = 1.40 commanded max > joint limit 1.2

// wristR / wristL patterns
frequency: 3.8, amplitude: ±0.50, restAngle: ∓0.6
waveform: 'upwhip', stabRoll: -0.32, tuckAngle: ∓0.85

// tailMuscle pattern
pitchBias: -0.4, stabPitch: -2.2, restAngle: -0.04

// Controller settings (in Bird.js after ctrl setup)
ctrl.trimPitch = 0.05
ctrl.gains.slipRoll = 0.15
ctrl.gains.yawToRoll = 0.4           // causes heading drift → bank → spiral
ctrl.bankCommand = 0.9               // ~52° max bank — causes spiral dive in turns
// rollLpf = 6 (default, not overridden)

// Wing strip gains
unsteadyGain = 2.0 on all main-wing strips
unsteadyGain = 0 on feather strips (suppressed to avoid double-counting LEV)
```

---

## FlappingController.js Key State (070babc)

Defaults in constructor:
```js
rollP: 1.6, rollD: 0.35
pitchP: 0.9, pitchD: 0.8
yawD: 0.55
yawToRoll: 0.4
vyDamp: 0.035
bankCommand: 0.9
rollLpf: 6   // rad/s
qLpf: 50     // rad/s
```

Trim computation (lines ~272–275):
```js
const ta = clamp(this.takeoffAssist, 0, 1);
const trim = this.trimPitch + 0.16 * climbCmd - 0.30 * diveCmd
  + 0.18 * brake
  - g.vyDamp * clamp(v.y, -4, 4) * (1 - ta) * (1 - pilotPitchAuth) * (1 - climbCmd)
  + 0.06 * ta;
```
The `(1 - climbCmd)` factor zeroes the phugoid damper during climb. The comment above it says this was justified by `flapBoost` — but `flapBoost` has been removed. The suppression is now a stale cheat causing zoom-stall.

Bias formula per muscle:
```js
bias = pat.pitchBias * input.pitchUp
     + pat.rollBias  * input.rollLeft
     + pat.stabRoll  * sRoll
     + pat.stabPitch * sPitch
     + pat.stabYaw   * sYaw
target = pat.restAngle + bias + (pat.brakeAngle ?? 0) * brake + amp * wave
```

Roll stabilizer:
```js
sRoll = clamp(-rollP*(rollAngle - rollSet) - rollD*p - yawCorr - slipRoll*vSide, -0.8, 0.8)
```
The `stabRoll: -0.40` on shoulder patterns is correct (sign convention: mirrored joints, negative stabRoll on right arm shifts target down = more downstroke = more lift = rolls right when sRoll>0).

Active twist: each wing strip has a registered twist wiring. During flight the strip's `pitchOffset` servos to keep AoA in [aMin, aMax]. `relax=0.7`, `max=0.6`, `aHold=0.03`, `twistDecay=100`.

Wake capture: implemented and wired. On shoulder joint-rate zero-crossing (upstroke→downstroke), injects `pitchOffset = 0.06 rad` decaying over 22ms onto the wing strips.

---

## Cheats Status

| Cheat | Status |
|---|---|
| `flapBoost` CG force | **Removed** — only in stale comments |
| `+0.05` post-stall drag offset in FluidSurface.js | **Removed** |
| Tail body-panel double-count | **Fixed** — `noBodyPanels: true` already on tail, arm, hand segments |
| `pitchBias` on shoulder/wrist patterns | **Fixed** — never present on those patterns; tail alone has `pitchBias: -0.4` (correct) |
| `unsteadyGain = 1.0` | **Fixed** — set to 2.0 |
| Wake capture | **Implemented** |
| `(1-climbCmd)` vyDamp suppression | **STILL PRESENT** — stale flapBoost holdover, causes zoom-stall |
| `_computeFold` in CreatureRenderer.js | **STILL PRESENT** — hardcoded renderer geometry override on dive |

---

## `_computeFold` — What It Is

`CreatureRenderer.js` lines 246–300. When `tuck > 0.02`, it computes hardcoded Euler rotations (arm swept 63°+26°, hand 83°+30°) and lerp-blends them over the actual rigid-body poses. The visual wing fold is synthetic — it ignores physics. The muscles already drive arm/hand toward `tuckAngle` (±0.30, ∓0.85 rad) when tuck is active, but `_computeFold` overrides that with its own geometry.

Note: A full physics sweep DOF (Gap 2a/2b from the original plan) was tried before and caused severe regressions — commit `9c67247` "Fix flight regressions from the honesty pass: remove harmful sweep pivot". Do not re-add the sweep pivot joint.

---

## Plan File

`/root/.claude/plans/i-want-to-build-majestic-cray.md` — maintained throughout the session, contains the full diagnosis of the remaining problems and the intended fixes.

---

## What Was Tried and Rejected

- **Amplitude 0.90 + restAngle 0.30** (commit `2b14d37`): All 9 tests pass but the bird descends in powered flight (vy oscillates negative). User said "you just made a worse version" and had it reverted via `git reset --hard 070babc`.
- **Sweep pivot DOF**: Added and removed (commit `9c67247`). Caused severe flight regressions.
- **rollBias on wristR/wristL**: Tested during prior sessions. Counterproductive — wrist droop during power stroke cancels roll effect from shoulder asymmetry. Not present in current Bird.js.
