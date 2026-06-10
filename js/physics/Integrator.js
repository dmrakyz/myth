// RK4 integrator over the 13-element rigid body state vector.
// Scratch arrays are module-level — single-threaded, reused every call.
const N = 13;
const s0 = new Float64Array(N);
const k1 = new Float64Array(N);
const k2 = new Float64Array(N);
const k3 = new Float64Array(N);
const k4 = new Float64Array(N);
const st = new Float64Array(N);

export function rk4Step(body, dt) {
  if (body.kinematic) return;

  body.getState(s0);

  body.computeDerivative(s0, k1);

  for (let i = 0; i < N; i++) st[i] = s0[i] + 0.5 * dt * k1[i];
  body.computeDerivative(st, k2);

  for (let i = 0; i < N; i++) st[i] = s0[i] + 0.5 * dt * k2[i];
  body.computeDerivative(st, k3);

  for (let i = 0; i < N; i++) st[i] = s0[i] + dt * k3[i];
  body.computeDerivative(st, k4);

  const h = dt / 6;
  for (let i = 0; i < N; i++) {
    st[i] = s0[i] + h * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  }

  // setState normalizes the quaternion and refreshes derived quantities
  body.setState(st);
}
