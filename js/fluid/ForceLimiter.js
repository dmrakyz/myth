import { Vec3 } from '../math/Vec3.js';

// Stability limiter for explicit aerodynamic forces on light bodies.
//
// Explicit integration of velocity-dependent fluid forces is conditionally
// stable: when (∂F/∂v)·dt exceeds the effective mass at the application
// point, the force overshoots and the loop diverges (a wing bone spinning up
// in milliseconds). Physically, a rigid model overpredicts loads that real
// flexible structures relieve by deforming. This limiter caps the force so
// one substep cannot change the application point's velocity by more than
// KAPPA × the local flow speed — guaranteeing geometric decay of any
// numerical oscillation while leaving ordinary flight loads untouched.
const KAPPA = 0.5;
const fHat = new Vec3();
const r = new Vec3();
const rxn = new Vec3();
const Irxn = new Vec3();
const xr = new Vec3();

// Returns the allowed scale factor (0..1] for `force` applied at worldPoint.
export function forceLimitScale(body, worldPoint, force, flowSpeed, dt) {
  const fMag = Vec3.len(force);
  if (fMag < 1e-12) return 1;
  Vec3.scale(force, 1 / fMag, fHat);
  Vec3.sub(worldPoint, body.position, r);

  // Effective inverse mass at the point along the force direction:
  // k = 1/m + ((I⁻¹(r×f̂))×r)·f̂
  Vec3.cross(r, fHat, rxn);
  const e = body.invInertiaWorld.e;
  Irxn.x = e[0] * rxn.x + e[1] * rxn.y + e[2] * rxn.z;
  Irxn.y = e[3] * rxn.x + e[4] * rxn.y + e[5] * rxn.z;
  Irxn.z = e[6] * rxn.x + e[7] * rxn.y + e[8] * rxn.z;
  Vec3.cross(Irxn, r, xr);
  const k = body.invMass + Vec3.dot(xr, fHat);
  if (k < 1e-12) return 1;

  // Δv this force would cause at the point in one substep
  const dv = fMag * k * dt;
  const maxDv = KAPPA * flowSpeed;
  return dv > maxDv ? maxDv / dv : 1;
}
