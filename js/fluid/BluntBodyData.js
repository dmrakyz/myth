import { AirfoilData } from './AirfoilData.js';

// Analytic coefficient profiles for non-wing surfaces. These let every body
// segment participate in the same BET pipeline as wings: a torso panel is just
// a "bad airfoil" with high base drag and weak lift.

export function registerBuiltinProfiles() {
  if (!AirfoilData.has('bluntbody')) {
    // Blunt body: high pressure drag, small crossflow lift. Cd0 ≈ 0.3
    // (between sphere 0.47 and streamlined fuselage 0.1).
    AirfoilData.registerAnalytic(
      'bluntbody',
      a => 0.4 * Math.sin(a) * Math.cos(a),
      a => 0.3 + 0.9 * Math.sin(a) * Math.sin(a),
    );
  }
  if (!AirfoilData.has('streamlined')) {
    // Fusiform body (fish/bird torso): low drag, moderate crossflow lift
    AirfoilData.registerAnalytic(
      'streamlined',
      a => 1.2 * Math.sin(a) * Math.cos(a),
      a => 0.04 + 1.1 * Math.sin(a) * Math.sin(a),
    );
  }
  if (!AirfoilData.has('flatplate')) {
    // Thin flat plate: thin-airfoil theory while attached, blending smoothly
    // into separated flat-plate behavior between 8° and 18° (stall region)
    const alpha = [], cl = [], cd = [];
    const stallStart = 8 * Math.PI / 180, stallEnd = 18 * Math.PI / 180;
    for (let deg = -180; deg <= 180; deg += 2) {
      const a = deg * Math.PI / 180;
      alpha.push(deg);
      const absA = Math.abs(a);
      const clAttached = 2 * Math.PI * a;
      const cdAttached = 0.008 + 0.5 * a * a;
      const clSep = 2 * Math.sin(a) * Math.cos(a);
      const cdSep = 0.02 + 2 * Math.sin(a) * Math.sin(a);
      let t;
      if (absA <= stallStart) t = 0;
      else if (absA >= stallEnd) t = 1;
      else t = (absA - stallStart) / (stallEnd - stallStart);
      cl.push(clAttached * (1 - t) + clSep * t);
      cd.push(cdAttached * (1 - t) + cdSep * t);
    }
    new AirfoilData('flatplate', { alpha, cl, cd });
  }
}
