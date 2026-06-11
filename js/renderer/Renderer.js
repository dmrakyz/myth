import * as THREE from 'three';

// Sun direction (low golden-hour angle) shared by sky, water glitter, lighting.
const SUN_DIR = new THREE.Vector3(0.35, 0.22, 0.9).normalize();

export class Renderer {
  constructor(container, waterSurface) {
    this.container = container;
    this.waterSurface = waterSurface;
    this._time = 0;
    this._lastNow = performance.now();

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    // Scene — dusk / golden hour
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x121a33);
    this.scene.fog = new THREE.Fog(0x9a7a8a, 120, 900);

    // Camera
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 3000);
    this.camera.position.set(0, 31.5, 8);

    // Camera follow state
    this._camTarget = new THREE.Vector3();
    this._camSmooth = new THREE.Vector3(0, 31.5, 8);

    // Lights — warm key sun + cool sky fill + subtle bounce
    const sun = new THREE.DirectionalLight(0xffd9a8, 3.1);
    sun.position.copy(SUN_DIR).multiplyScalar(100);
    this.scene.add(sun);
    const sky = new THREE.HemisphereLight(0xbcd0ff, 0x3a3046, 1.4);
    this.scene.add(sky);
    const rim = new THREE.DirectionalLight(0x8090c0, 0.6);
    rim.position.set(-40, 20, -30);
    this.scene.add(rim);

    // Environment
    this._buildSky();
    this._buildSun();
    this._buildClouds();
    this._buildWater();
    this._buildHorizonGrid();
    this._buildStars();

    // Touch / mouse orbit
    this._touch = { active: false, lastX: 0, lastY: 0, dist: 0 };
    this._orbitYaw = 0;
    this._orbitPitch = 0.18;
    this._orbitDist = 8;
    this._bindOrbit();

    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  // ── Sky gradient dome ──────────────────────────────────────────────────────
  _buildSky() {
    const geo = new THREE.SphereGeometry(2000, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        zenith:  { value: new THREE.Color(0x0e1838) },
        middle:  { value: new THREE.Color(0x5a6a9a) },
        horizon: { value: new THREE.Color(0xe8956a) },
        sunDir:  { value: SUN_DIR.clone() },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vDir;
        uniform vec3 zenith; uniform vec3 middle; uniform vec3 horizon; uniform vec3 sunDir;
        void main() {
          float h = clamp(vDir.y, -1.0, 1.0);
          vec3 col = h > 0.0
            ? mix(middle, zenith, pow(h, 0.65))
            : mix(middle, horizon * 0.7, clamp(-h * 4.0, 0.0, 1.0));
          // warm glow around the sun low on the horizon
          float sd = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
          col += horizon * pow(sd, 6.0) * 0.6;
          col += vec3(1.0, 0.85, 0.6) * pow(sd, 64.0) * 0.8;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  // ── Sun sprite (additive glow) ──────────────────────────────────────────────
  _buildSun() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0.0, 'rgba(255,248,230,1)');
    g.addColorStop(0.18, 'rgba(255,224,170,0.9)');
    g.addColorStop(0.5, 'rgba(255,170,110,0.35)');
    g.addColorStop(1.0, 'rgba(255,150,100,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const sun = new THREE.Sprite(mat);
    sun.scale.set(260, 260, 1);
    sun.position.copy(SUN_DIR).multiplyScalar(1600);
    this.scene.add(sun);
    this._sun = sun;
  }

  // ── Drifting cloud billboards ───────────────────────────────────────────────
  _buildClouds() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    // Soft lumpy blob from several overlapping radial gradients
    for (let i = 0; i < 14; i++) {
      const x = 60 + Math.random() * 136, y = 90 + Math.random() * 76;
      const r = 30 + Math.random() * 50;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 256);
    }
    const tex = new THREE.CanvasTexture(c);

    this._clouds = new THREE.Group();
    const tints = [0xfff0e0, 0xe8d4e8, 0xd8c0d0, 0xffe8d0];
    for (let i = 0; i < 28; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 0.45 + Math.random() * 0.3,
        color: tints[i % tints.length], depthWrite: false,
      });
      const s = new THREE.Sprite(mat);
      const scale = 60 + Math.random() * 120;
      s.scale.set(scale, scale * 0.6, 1);
      s.position.set(
        (Math.random() - 0.5) * 1400,
        70 + Math.random() * 160,
        (Math.random() - 0.5) * 1400,
      );
      s.userData.driftX = 1 + Math.random() * 2;
      this._clouds.add(s);
    }
    this.scene.add(this._clouds);
  }

  // ── Animated Gerstner-wave water ────────────────────────────────────────────
  _buildWater() {
    const geo = new THREE.PlaneGeometry(1600, 1600, 200, 200);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        time:     { value: 0 },
        deep:     { value: new THREE.Color(0x0a2436) },
        shallow:  { value: new THREE.Color(0x1d5a72) },
        skyTint:  { value: new THREE.Color(0xe8956a) },
        sunDir:   { value: SUN_DIR.clone() },
        fogColor: { value: new THREE.Color(0x9a7a8a) },
        fogNear:  { value: 120 },
        fogFar:   { value: 900 },
      },
      vertexShader: `
        uniform float time;
        varying vec3 vWorld;
        varying vec3 vNormal;
        // sum of a few Gerstner-ish sine waves for height + analytic normal
        float wave(vec2 p, vec2 d, float k, float w, float t, out vec2 deriv) {
          float ph = dot(d, p) * k + t * w;
          deriv = d * k * cos(ph);
          return sin(ph);
        }
        void main() {
          vec3 pos = position;
          vec2 p = position.xz;
          float h = 0.0; vec2 dsum = vec2(0.0); vec2 dv;
          h += 0.45 * wave(p, normalize(vec2( 1.0, 0.3)), 0.018, 0.9, time, dv); dsum += 0.45 * dv;
          h += 0.30 * wave(p, normalize(vec2(-0.6, 1.0)), 0.031, 1.3, time, dv); dsum += 0.30 * dv;
          h += 0.16 * wave(p, normalize(vec2( 0.8,-0.7)), 0.060, 1.9, time, dv); dsum += 0.16 * dv;
          pos.y += h;
          vNormal = normalize(vec3(-dsum.x, 1.0, -dsum.y));
          vec4 wp = modelMatrix * vec4(pos, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        varying vec3 vWorld;
        varying vec3 vNormal;
        uniform vec3 deep; uniform vec3 shallow; uniform vec3 skyTint; uniform vec3 sunDir;
        uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
        void main() {
          vec3 N = normalize(vNormal);
          vec3 V = normalize(cameraPosition - vWorld);
          float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
          vec3 col = mix(deep, shallow, max(N.y, 0.0));
          col = mix(col, skyTint, fres * 0.6);
          // specular sun glitter
          vec3 H = normalize(sunDir + V);
          float spec = pow(max(dot(N, H), 0.0), 120.0);
          col += vec3(1.0, 0.9, 0.7) * spec * 1.4;
          float d = length(cameraPosition - vWorld);
          float f = clamp((d - fogNear) / (fogFar - fogNear), 0.0, 1.0);
          col = mix(col, fogColor, f);
          gl_FragColor = vec4(col, 0.94);
        }`,
    });
    const water = new THREE.Mesh(geo, mat);
    water.position.y = this.waterSurface?.level ?? -10;
    water.frustumCulled = false;
    this.scene.add(water);
    this._waterMesh = water;
    this._waterMat = mat;
  }

  // ── Faint reference grid just above the water ───────────────────────────────
  _buildHorizonGrid() {
    const grid = new THREE.GridHelper(1600, 80, 0x6a8aba, 0x40506a);
    grid.material.transparent = true;
    grid.material.opacity = 0.12;
    grid.position.y = (this.waterSurface?.level ?? -10) + 0.08;
    this.scene.add(grid);
    this._gridMesh = grid;
    this._gridCell = 1600 / 80;
  }

  // ── Stars high in the zenith (fade in up high) ──────────────────────────────
  _buildStars() {
    const geo = new THREE.BufferGeometry();
    const verts = [];
    for (let i = 0; i < 500; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.6 + 0.4); // upper hemisphere only
      const r = 1700;
      verts.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta),
      );
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const mat = new THREE.PointsMaterial({ color: 0xaab4d0, size: 2.0, sizeAttenuation: true, transparent: true, opacity: 0.5, fog: false });
    this.scene.add(new THREE.Points(geo, mat));
  }

  _bindOrbit() {
    const el = this.renderer.domElement;
    let mouseDown = false, mx = 0, my = 0;
    el.addEventListener('mousedown', e => { mouseDown = true; mx = e.clientX; my = e.clientY; });
    window.addEventListener('mouseup', () => { mouseDown = false; });
    window.addEventListener('mousemove', e => {
      if (!mouseDown) return;
      this._orbitYaw   -= (e.clientX - mx) * 0.005;
      this._orbitPitch += (e.clientY - my) * 0.004;
      this._orbitPitch = Math.max(-0.1, Math.min(1.2, this._orbitPitch));
      mx = e.clientX; my = e.clientY;
    });
    el.addEventListener('wheel', e => {
      this._orbitDist = Math.max(3, Math.min(120, this._orbitDist + e.deltaY * 0.04));
    }, { passive: true });

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
        this._orbitYaw   -= (e.touches[0].clientX - this._touch.lastX) * 0.006;
        this._orbitPitch += (e.touches[0].clientY - this._touch.lastY) * 0.005;
        this._orbitPitch = Math.max(-0.1, Math.min(1.2, this._orbitPitch));
        this._touch.lastX = e.touches[0].clientX;
        this._touch.lastY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const d = Math.hypot(dx, dy);
        this._orbitDist = Math.max(3, Math.min(120, this._orbitDist * (this._touch.dist / d)));
        this._touch.dist = d;
      }
    }, { passive: true });
    el.addEventListener('touchend', () => { this._touch.active = false; }, { passive: true });
  }

  followTarget(creature) {
    const c = creature.getCentroid();
    this._camTarget.set(c.x, c.y, c.z);

    // Keep ocean + grid centered under the creature (grid snapped to cells)
    if (this._waterMesh) { this._waterMesh.position.x = c.x; this._waterMesh.position.z = c.z; }
    if (this._gridMesh) {
      const cell = this._gridCell;
      this._gridMesh.position.x = Math.round(c.x / cell) * cell;
      this._gridMesh.position.z = Math.round(c.z / cell) * cell;
    }
    // Clouds + sun follow horizontally so they stay "infinitely" far
    if (this._clouds) { this._clouds.position.x = c.x; this._clouds.position.z = c.z; }
    if (this._sun) { this._sun.position.copy(SUN_DIR).multiplyScalar(1600).add(new THREE.Vector3(c.x, 0, c.z)); }

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
    const now = performance.now();
    const dt = Math.min((now - this._lastNow) / 1000, 0.05);
    this._lastNow = now;
    this._time += dt;

    if (this._waterMat) this._waterMat.uniforms.time.value = this._time;
    if (this._clouds) {
      for (const s of this._clouds.children) {
        s.position.x += s.userData.driftX * dt;
        if (s.position.x > 750) s.position.x -= 1500;
      }
    }
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
