import * as THREE from 'three';

export class Renderer {
  constructor(container, waterSurface) {
    this.container = container;
    this.waterSurface = waterSurface;
    this._clock = { last: 0 };

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    container.appendChild(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0e14);
    this.scene.fog = new THREE.FogExp2(0x0a0e14, 0.006);

    // Camera
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1500);
    this.camera.position.set(0, 10, 30);

    // Camera follow state
    this._camTarget = new THREE.Vector3();
    this._camOffset = new THREE.Vector3(0, 4, 22);
    this._camSmooth = new THREE.Vector3(0, 10, 30);

    // Lights
    const ambient = new THREE.AmbientLight(0x3a4a60, 1.5);
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xfff5e0, 3.0);
    sun.position.set(30, 60, -40);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x204060, 0.8);
    fill.position.set(-20, 10, 20);
    this.scene.add(fill);

    // Ground / water
    this._buildEnvironment();

    // Touch orbit
    this._touch = { active: false, lastX: 0, lastY: 0, dist: 0 };
    this._orbitYaw = 0;
    this._orbitPitch = 0.18;
    this._orbitDist = 22;
    this._bindOrbit();

    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _buildEnvironment() {
    // Ocean plane
    const waterGeo = new THREE.PlaneGeometry(2000, 2000, 1, 1);
    const waterMat = new THREE.MeshPhongMaterial({
      color: 0x0d2a42, emissive: 0x040f18, specular: 0x4488cc,
      shininess: 80, transparent: true, opacity: 0.85,
    });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = this.waterSurface?.level ?? -10;
    this.scene.add(water);
    this._waterMesh = water;

    // Horizon grid (light, far)
    const grid = new THREE.GridHelper(400, 40, 0x1a2840, 0x1a2840);
    grid.position.y = (this.waterSurface?.level ?? -10) + 0.05;
    this.scene.add(grid);

    // Stars / sky particles
    const starGeo = new THREE.BufferGeometry();
    const starVerts = [];
    for (let i = 0; i < 800; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 600 + Math.random() * 400;
      starVerts.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta),
      );
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starVerts, 3));
    const starMat = new THREE.PointsMaterial({ color: 0x8898aa, size: 1.5, sizeAttenuation: true });
    this.scene.add(new THREE.Points(starGeo, starMat));
  }

  _bindOrbit() {
    const el = this.renderer.domElement;
    // Mouse orbit (desktop)
    let mouseDown = false, mx = 0, my = 0;
    el.addEventListener('mousedown', e => { mouseDown = true; mx = e.clientX; my = e.clientY; });
    window.addEventListener('mouseup', () => { mouseDown = false; });
    window.addEventListener('mousemove', e => {
      if (!mouseDown) return;
      this._orbitYaw   += (e.clientX - mx) * 0.005;
      this._orbitPitch += (e.clientY - my) * 0.004;
      this._orbitPitch = Math.max(-0.1, Math.min(1.2, this._orbitPitch));
      mx = e.clientX; my = e.clientY;
    });
    el.addEventListener('wheel', e => {
      this._orbitDist = Math.max(4, Math.min(120, this._orbitDist + e.deltaY * 0.04));
    }, { passive: true });

    // Two-finger touch orbit/pinch (mobile)
    el.addEventListener('touchstart', e => {
      if (e.touches.length === 1) {
        this._touch.active = true;
        this._touch.lastX = e.touches[0].clientX;
        this._touch.lastY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        this._touch.dist = Math.hypot(dx, dy);
      }
    }, { passive: true });
    el.addEventListener('touchmove', e => {
      if (e.touches.length === 1 && this._touch.active) {
        this._orbitYaw   += (e.touches[0].clientX - this._touch.lastX) * 0.006;
        this._orbitPitch += (e.touches[0].clientY - this._touch.lastY) * 0.005;
        this._orbitPitch = Math.max(-0.1, Math.min(1.2, this._orbitPitch));
        this._touch.lastX = e.touches[0].clientX;
        this._touch.lastY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const d = Math.hypot(dx, dy);
        this._orbitDist = Math.max(4, Math.min(120, this._orbitDist * (this._touch.dist / d)));
        this._touch.dist = d;
      }
    }, { passive: true });
    el.addEventListener('touchend', () => { this._touch.active = false; }, { passive: true });
  }

  followTarget(creature) {
    const c = creature.getCentroid();
    this._camTarget.set(c.x, c.y, c.z);

    // Orbit around the target
    const d = this._orbitDist;
    const py = this._orbitPitch;
    const ya = this._orbitYaw;
    const dx = d * Math.cos(py) * Math.sin(ya);
    const dy = d * Math.sin(py);
    const dz = d * Math.cos(py) * Math.cos(ya);

    const desired = new THREE.Vector3(c.x + dx, c.y + dy, c.z + dz);
    this._camSmooth.lerp(desired, 0.1);
    this.camera.position.copy(this._camSmooth);
    this.camera.lookAt(this._camTarget);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  _resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
