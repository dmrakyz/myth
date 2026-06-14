import * as THREE from 'three';
import { CreatureRenderer } from './CreatureRenderer.js';

// A dedicated creature-creation environment, fully separate from the flight
// world: its own scene, studio lighting, a turntable platform and a neutral
// gradient backdrop. The creature being edited is shown here in a static rest
// pose (membranes relaxed into shape, no physics integration) so it can be
// inspected and modified, then spawned into the flight world on "Fly".
//
// Shares the flight Renderer's WebGLRenderer/canvas — only the scene + camera
// swap when entering build mode, so there is exactly one GL context.
const _v = new THREE.Vector3();

export class BuilderScene {
  constructor(webglRenderer) {
    this.gl = webglRenderer;
    this.active = false;
    this.creatureRenderer = null;
    this._creature = null;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1119);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);

    // Orbit state (around the creature centroid)
    this.target = new THREE.Vector3(0, 0, 0);
    this._yaw = 0.6;
    this._pitch = 0.32;
    this._dist = 2.0;
    this._autoSpin = true;     // gentle turntable until the user interacts

    this._buildBackdrop();
    this._buildLighting();
    this._buildPlatform();
    this._bindOrbit(webglRenderer.domElement);

    window.addEventListener('resize', () => this._resize());
  }

  // ── Neutral studio backdrop: vertical gradient dome with a soft glow ──────
  _buildBackdrop() {
    const geo = new THREE.SphereGeometry(60, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: {
        top:    { value: new THREE.Color(0x0a0d14) },
        bottom: { value: new THREE.Color(0x1b2533) },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vDir;
        uniform vec3 top; uniform vec3 bottom;
        void main() {
          float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 col = mix(bottom, top, pow(h, 0.8));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  _buildLighting() {
    // Key light (warm, casts shadow onto the platform)
    const key = new THREE.DirectionalLight(0xfff2e0, 2.6);
    key.position.set(2.5, 4, 3);
    key.castShadow = true;
    key.shadow.mapSize.width = 1024;
    key.shadow.mapSize.height = 1024;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 14;
    key.shadow.camera.left = -2.2;
    key.shadow.camera.right = 2.2;
    key.shadow.camera.top = 2.2;
    key.shadow.camera.bottom = -2.2;
    key.shadow.bias = -0.0015;
    this.scene.add(key);
    this.scene.add(key.target);

    // Cool fill from the opposite side
    const fill = new THREE.DirectionalLight(0x6fa8d8, 0.9);
    fill.position.set(-3, 1.5, -2);
    this.scene.add(fill);

    // Soft ambient + ground bounce
    this.scene.add(new THREE.HemisphereLight(0x9fb8d8, 0x141820, 1.1));

    // Rim from behind for silhouette separation against the dark backdrop
    const rim = new THREE.DirectionalLight(0xbfe0ff, 0.8);
    rim.position.set(0, 2, -5);
    this.scene.add(rim);
  }

  // ── Turntable platform: a disc with concentric accent rings ──────────────
  _buildPlatform() {
    this.platform = new THREE.Group();

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1.6, 64).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0x10151e, roughness: 0.85, metalness: 0.1,
        transparent: true, opacity: 0.92,
      }),
    );
    disc.receiveShadow = true;
    this.platform.add(disc);

    // Concentric grid rings (accent blue), fading outward
    const grid = new THREE.PolarGridHelper(1.55, 16, 6, 64, 0x2a4a6a, 0x1c2c40);
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    grid.position.y = 0.002;
    this.platform.add(grid);

    // Bright edge ring
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.55, 1.62, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x4da3ff, transparent: true, opacity: 0.6 }),
    );
    ring.position.y = 0.003;
    this.platform.add(ring);

    this.scene.add(this.platform);
  }

  // Build (or rebuild) the creature renderer for a given creature, frame the
  // camera on it, drop the platform under its feet, and relax membranes.
  setCreature(creature) {
    this._creature = creature;
    if (this.creatureRenderer) this.scene.remove(this.creatureRenderer.group);
    this.creatureRenderer = new CreatureRenderer(this.scene, creature);

    // Relax any membrane cloth into its rest shape against the frozen skeleton.
    for (const m of creature.membranes.values()) m.settle?.();
    this.creatureRenderer.update(1);

    this._frame(creature);
    this._autoSpin = true;
    this.platform.rotation.y = 0;
  }

  // Position the platform and camera from the creature's bounding box.
  _frame(creature) {
    let minY = Infinity, maxR = 0;
    const cx = creature.getCentroid();
    for (const s of creature.segments.values()) {
      const p = s.rigidBody.position;
      const d = Math.max(...s.dimensions);
      minY = Math.min(minY, p.y - d);
      maxR = Math.max(maxR, Math.hypot(p.x - cx.x, p.z - cx.z) + d, Math.abs(p.y - cx.y) + d);
    }
    if (!isFinite(minY)) { minY = -0.3; maxR = 0.5; }

    this.target.set(cx.x, cx.y, cx.z);
    this.platform.position.set(cx.x, minY - 0.02, cx.z);
    // Frame so the creature fills ~60% of the vertical view
    const fov = this.camera.fov * Math.PI / 180;
    this._dist = Math.max(0.8, (maxR * 1.9) / Math.tan(fov / 2));
  }

  _bindOrbit(el) {
    let down = false, mx = 0, my = 0;
    const stopSpin = () => { this._autoSpin = false; };

    el.addEventListener('mousedown', e => {
      if (!this.active) return;
      down = true; mx = e.clientX; my = e.clientY; stopSpin();
    });
    window.addEventListener('mouseup', () => { down = false; });
    window.addEventListener('mousemove', e => {
      if (!this.active || !down) return;
      this._yaw -= (e.clientX - mx) * 0.006;
      this._pitch += (e.clientY - my) * 0.005;
      this._pitch = Math.max(-0.4, Math.min(1.3, this._pitch));
      mx = e.clientX; my = e.clientY;
    });
    el.addEventListener('wheel', e => {
      if (!this.active) return;
      this._dist = Math.max(0.4, Math.min(20, this._dist + e.deltaY * 0.002 * this._dist));
    }, { passive: true });

    // Touch: 1-finger orbit, 2-finger pinch zoom
    const t = { x: 0, y: 0, d: 0, single: false };
    el.addEventListener('touchstart', e => {
      if (!this.active) return;
      stopSpin();
      if (e.touches.length === 1) { t.single = true; t.x = e.touches[0].clientX; t.y = e.touches[0].clientY; }
      else if (e.touches.length === 2) {
        t.single = false;
        t.d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      }
    }, { passive: true });
    el.addEventListener('touchmove', e => {
      if (!this.active) return;
      if (e.touches.length === 1 && t.single) {
        this._yaw -= (e.touches[0].clientX - t.x) * 0.007;
        this._pitch += (e.touches[0].clientY - t.y) * 0.006;
        this._pitch = Math.max(-0.4, Math.min(1.3, this._pitch));
        t.x = e.touches[0].clientX; t.y = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (t.d > 0) this._dist = Math.max(0.4, Math.min(20, this._dist * (t.d / d)));
        t.d = d;
      }
    }, { passive: true });
    el.addEventListener('touchend', e => { if (e.touches.length === 0) t.single = false; }, { passive: true });
  }

  update(dt) {
    if (!this._creature) return;

    // The skeleton is frozen and the membrane was settled into its rest shape
    // on entry, so we only re-sync meshes (cheap; also reflects live edits).
    this.creatureRenderer.update(1);

    // Gentle turntable until the user grabs the view.
    if (this._autoSpin) this.platform.rotation.y += dt * 0.25;

    // Orbit the camera around the (optionally spinning) creature. Spin the
    // camera with the platform so the creature appears to rotate on the disc.
    const yaw = this._yaw + this.platform.rotation.y;
    const cp = Math.cos(this._pitch);
    _v.set(
      this.target.x + this._dist * cp * Math.sin(yaw),
      this.target.y + this._dist * Math.sin(this._pitch),
      this.target.z + this._dist * cp * Math.cos(yaw),
    );
    this.camera.position.copy(_v);
    this.camera.lookAt(this.target);

    this._applyViewOffset();
  }

  // Shift the rendered image so the creature sits in the clear area beside the
  // builder panel (left sidebar on wide screens, bottom sheet on narrow ones).
  _applyViewOffset() {
    const panel = document.getElementById('build-props-panel');
    const W = this.gl.domElement.clientWidth || window.innerWidth;
    const H = this.gl.domElement.clientHeight || window.innerHeight;
    let ox = 0, oy = 0;
    if (panel && panel.offsetParent !== null) {
      const r = panel.getBoundingClientRect();
      const sidePanel = r.width < W * 0.7 && r.height > H * 0.6;
      if (sidePanel) ox = -r.width / 2;          // push subject right of the sidebar
      else oy = (H - r.top) / 2;                 // push subject up above the sheet
    }
    if (ox === 0 && oy === 0) this.camera.clearViewOffset();
    else this.camera.setViewOffset(W, H, ox, oy, W, H);
  }

  render() {
    this.gl.render(this.scene, this.camera);
  }

  _resize() {
    if (!this.active) return;
    const w = this.gl.domElement.clientWidth || window.innerWidth;
    const h = this.gl.domElement.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
