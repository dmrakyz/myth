import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';

// Frame-scoped scratch pools. acquire() hands out a pre-allocated instance;
// releaseAll() resets the cursor once per physics substep. Never hold a pooled
// object across a releaseAll() boundary.
class Pool {
  constructor(factory, size) {
    this.items = new Array(size);
    for (let i = 0; i < size; i++) this.items[i] = factory();
    this.cursor = 0;
    this.factory = factory;
  }

  acquire() {
    if (this.cursor >= this.items.length) {
      // Grow rather than crash; logged once so leaks are noticeable in dev.
      this.items.push(this.factory());
    }
    return this.items[this.cursor++];
  }

  releaseAll() { this.cursor = 0; }
}

export const vec3Pool = new Pool(() => new Vec3(), 128);
export const quatPool = new Pool(() => new Quat(), 16);

export function resetPools() {
  vec3Pool.releaseAll();
  quatPool.releaseAll();
}
