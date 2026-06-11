import * as THREE from 'three';

// Afternoon sun: ~44° elevation, south-west direction
const SUN_DIR = new THREE.Vector3(0.55, 0.70, 0.45).normalize();

export class Renderer {
  constructor(container, waterSurface, terrain = null) {
    this.container = container;
    this.waterSurface = waterSurface;
    this.terrain = terrain;
    this._time = 0;
    this._lastNow = performance.now();

    // Renderer — enable shadow maps for bird-on-ground shadow
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.10;
    container.appendChild(this.renderer.domElement);

    // Scene — clear daytime sky
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x4b8fd6);
    this.scene.fog = new THREE.Fog(0x9fc7e4, 300, 2000);

    // Camera
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 3000);
    this.camera.position.set(0, 31.5, 8);

    // Camera follow state
    this._camTarget = new THREE.Vector3();
    this._camSmooth = new THREE.Vector3(0, 31.5, 8);

    // Sun: warm white afternoon light with shadow casting
    const sun = new THREE.DirectionalLight(0xfff4e0, 3.2);
    sun.position.copy(SUN_DIR).multiplyScalar(200);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 450;
    sun.shadow.camera.left   = -90;
    sun.shadow.camera.right  =  90;
    sun.shadow.camera.top    =  90;
    sun.shadow.camera.bottom = -90;
    sun.shadow.bias = -0.0008;
    this.scene.add(sun);
    this.scene.add(sun.target);  // target must be in scene for shadow to follow
    this._sunLight = sun;

    // Sky fill: blue sky above, green-earth bounce below
    const sky = new THREE.HemisphereLight(0xb8d8f0, 0x3d5c2a, 1.5);
    this.scene.add(sky);
    // Subtle rim from the east
    const rim = new THREE.DirectionalLight(0x88b8c8, 0.35);
    rim.position.set(-60, 30, -40);
    this.scene.add(rim);

    // Environment
    this._buildSky();
    this._buildSun();
    if (this.terrain) this._buildTerrain();
    else this._buildMountains();
    this._buildClouds();
    this._buildWater();
    if (!this.terrain) this._buildHorizonGrid();
    this._buildFlock();

    // Touch / mouse orbit
    this._touch = { active: false, lastX: 0, lastY: 0, dist: 0 };
    this._orbitYaw = 0;
    this._orbitPitch = 0.18;
    this._orbitDist = 8;
    this._bindOrbit();

    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  // ── Daytime sky gradient dome ──────────────────────────────────────────
  _buildSky() {
    const geo = new THREE.SphereGeometry(2000, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        zenith:  { value: new THREE.Color(0x1a5eb8) },
        middle:  { value: new THREE.Color(0x4b8fd6) },
        horizon: { value: new THREE.Color(0xa0cce8) },
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
            ? mix(middle, zenith, pow(h, 0.55))
            : mix(middle, horizon * 0.85, clamp(-h * 3.0, 0.0, 1.0));
          // subtle sun halo
          float sd = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
          col += vec3(1.0, 0.96, 0.82) * pow(sd, 10.0) * 0.18;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  // ── Sun sprite (additive glow) ─────────────────────────────────────────
  _buildSun() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0.0,  'rgba(255,252,230,1)');
    g.addColorStop(0.14, 'rgba(255,242,200,0.9)');
    g.addColorStop(0.45, 'rgba(255,230,160,0.3)');
    g.addColorStop(1.0,  'rgba(255,220,120,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const sun = new THREE.Sprite(mat);
    sun.scale.set(220, 220, 1);
    sun.position.copy(SUN_DIR).multiplyScalar(1600);
    this.scene.add(sun);
    this._sun = sun;
  }

  // ── Procedural grass texture for terrain detail ──────────────────────
  _createGrassTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');

    // Near-white base: vertex colors supply the biome hue, this adds micro detail
    ctx.fillStyle = '#f2f0ea';
    ctx.fillRect(0, 0, 128, 128);

    // Grass blade silhouettes — dark vertical strokes
    for (let i = 0; i < 350; i++) {
      const x = Math.random() * 128;
      const y = Math.random() * 128;
      const h = 3 + Math.random() * 6;
      const v = 0.40 + Math.random() * 0.30;
      ctx.strokeStyle = `rgba(${Math.round(v * 60)},${Math.round(v * 80)},${Math.round(v * 30)},0.40)`;
      ctx.lineWidth = 0.7 + Math.random() * 0.6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (Math.random() - 0.5) * 2, y - h);
      ctx.stroke();
    }

    // Occasional bright highlight flecks (dew / light catch)
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.12 + Math.random() * 0.15})`;
      ctx.fillRect(Math.random() * 128, Math.random() * 128, 1, 1);
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(220, 220);  // ~14.5 m per tile on the 3200 m terrain
    return tex;
  }

  // ── Volumetric cloud formations ────────────────────────────────────────
  _buildClouds() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    for (let i = 0; i < 14; i++) {
      const x = 55 + Math.random() * 146, y = 85 + Math.random() * 86;
      const r = 28 + Math.random() * 52;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0,   'rgba(255,255,255,0.62)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.20)');
      g.addColorStop(1,   'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 256);
    }
    const tex = new THREE.CanvasTexture(c);

    this._clouds = new THREE.Group();
    const tints = [0xffffff, 0xf5f0ff, 0xeaeeff, 0xf8f8ff];

    for (let i = 0; i < 14; i++) {
      const cx = (Math.random() - 0.5) * 1600;
      const cz = (Math.random() - 0.5) * 1600;
      const cy = 120 + Math.random() * 200;
      const baseScale = 65 + Math.random() * 130;
      const tint = tints[i % tints.length];
      const driftX = 0.6 + Math.random() * 1.5;
      const count = 3 + Math.floor(Math.random() * 3);
      for (let j = 0; j < count; j++) {
        const mat = new THREE.SpriteMaterial({
          map: tex, transparent: true,
          opacity: 0.28 + Math.random() * 0.30,
          color: tint, depthWrite: false,
        });
        const s = new THREE.Sprite(mat);
        const sc = baseScale * (0.65 + Math.random() * 0.70);
        s.scale.set(sc, sc * 0.46, 1);
        s.position.set(
          cx + (Math.random() - 0.5) * baseScale * 0.9,
          cy + (Math.random() - 0.5) * baseScale * 0.18,
          cz + (Math.random() - 0.5) * baseScale * 0.65,
        );
        s.userData.driftX = driftX;
        this._clouds.add(s);
      }
    }
    this.scene.add(this._clouds);
  }

  // ── Animated Gerstner-wave water ──────────────────────────────────────
  _buildWater() {
    const geo = new THREE.PlaneGeometry(1600, 1600, 200, 200);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        time:     { value: 0 },
        deep:     { value: new THREE.Color(0x0f3a54) },
        shallow:  { value: new THREE.Color(0x2474a0) },
        skyTint:  { value: new THREE.Color(0xa0cce8) },
        sunDir:   { value: SUN_DIR.clone() },
        fogColor: { value: new THREE.Color(0x9fc7e4) },
        fogNear:  { value: 300 },
        fogFar:   { value: 2000 },
      },
      vertexShader: `
        uniform float time;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vHeight;
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
          vHeight = h;
          vNormal = normalize(vec3(-dsum.x, 1.0, -dsum.y));
          vec4 wp = modelMatrix * vec4(pos, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vHeight;
        uniform vec3 deep; uniform vec3 shallow; uniform vec3 skyTint; uniform vec3 sunDir;
        uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
        void main() {
          vec3 N = normalize(vNormal);
          vec3 V = normalize(cameraPosition - vWorld);
          float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
          vec3 col = mix(deep, shallow, max(N.y, 0.0));
          col = mix(col, skyTint, fres * 0.55);
          vec3 H = normalize(sunDir + V);
          float spec = pow(max(dot(N, H), 0.0), 180.0);
          col += vec3(1.0, 0.97, 0.88) * spec * 1.6;
          float foam = smoothstep(0.32, 0.68, vHeight);
          col = mix(col, vec3(0.90, 0.94, 0.97), foam * 0.42);
          float d = length(cameraPosition - vWorld);
          float f = clamp((d - fogNear) / (fogFar - fogNear), 0.0, 1.0);
          col = mix(col, fogColor, f);
          gl_FragColor = vec4(col, 0.92);
        }`,
    });
    const water = new THREE.Mesh(geo, mat);
    water.position.y = this.waterSurface?.level ?? -10;
    water.frustumCulled = false;
    water.receiveShadow = true;
    this.scene.add(water);
    this._waterMesh = water;
    this._waterMat = mat;
  }

  // ── Reference grid (no-terrain mode only) ─────────────────────────────
  _buildHorizonGrid() {
    const grid = new THREE.GridHelper(1600, 80, 0x6a8aba, 0x40506a);
    grid.material.transparent = true;
    grid.material.opacity = 0.12;
    grid.position.y = (this.waterSurface?.level ?? -10) + 0.08;
    this.scene.add(grid);
    this._gridMesh = grid;
    this._gridCell = 1600 / 80;
  }

  // ── Procedural terrain mesh (matches physics heightfield exactly) ────
  _buildTerrain() {
    const SIZE = 3200, RES = 220;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, RES, RES);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const sea = this.terrain.seaLevel;
    const col = new THREE.Color();
    const sand    = new THREE.Color(0xb8a87e);
    const wetSand = new THREE.Color(0x8a7a62);
    const grass   = new THREE.Color(0x5e6e42);
    const scrub   = new THREE.Color(0x77704a);
    const rock    = new THREE.Color(0x6e6058);
    const snow    = new THREE.Color(0xe6e2d8);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = this.terrain.height(x, z);
      pos.setY(i, h);
      const a = h - sea;
      if (a < 0.5)       col.copy(wetSand);
      else if (a < 2.5)  col.copy(sand).lerp(wetSand, (2.5 - a) / 2);
      else if (a < 12)   col.copy(grass).lerp(sand, Math.max(0, (4 - a) / 1.5));
      else if (a < 22)   col.copy(scrub).lerp(grass, (22 - a) / 10);
      else if (a < 32)   col.copy(rock).lerp(scrub, (32 - a) / 10);
      else               col.copy(snow).lerp(rock, Math.max(0, (40 - a) / 8));
      const v = 0.92 + 0.08 * Math.abs(Math.sin(x * 12.9898 + z * 78.233));
      colors[i * 3]     = col.r * v;
      colors[i * 3 + 1] = col.g * v;
      colors[i * 3 + 2] = col.b * v;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshPhongMaterial({
      vertexColors: true,
      map: this._createGrassTex(),
      shininess: 6,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    this.scene.add(mesh);
    this._terrainMesh = mesh;
  }

  // ── Distant mountain silhouette ring (no-terrain mode) ────────────────
  _buildMountains() {
    const W = 2048, H = 256;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    const drawRange = (baseH, r, g, b, a) => {
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 3) {
        const t = x / W;
        const h = baseH
          + Math.sin(t * Math.PI *  3.7 + 0.4) * 26
          + Math.sin(t * Math.PI *  8.1 + 1.1) * 16
          + Math.sin(t * Math.PI * 17.3 + 0.8) * 10
          + Math.sin(t * Math.PI * 36.9 + 2.2) *  6;
        ctx.lineTo(x, H - Math.max(0, h));
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
      ctx.fill();
    };

    drawRange(118, 42, 65, 95, 0.88);
    drawRange( 68, 60, 88, 118, 0.90);

    const tex = new THREE.CanvasTexture(c);
    this._mountains = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const angle = i * Math.PI / 2;
      const mat = new THREE.MeshBasicMaterial({
        map: tex.clone(), transparent: true, alphaTest: 0.01,
        side: THREE.DoubleSide, depthWrite: false, fog: false,
      });
      mat.map.offset.x = i * 0.25;
      mat.map.needsUpdate = true;
      const geo = new THREE.PlaneGeometry(1600, 200);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(Math.sin(angle) * 700, 78, Math.cos(angle) * 700);
      mesh.rotation.y = -angle;
      mesh.frustumCulled = false;
      this._mountains.add(mesh);
    }
    this.scene.add(this._mountains);
  }

  // ── Distant bird flock silhouette ─────────────────────────────────────
  _buildFlock() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 256, 128);

    const birds = [
      [128, 46],
      [103, 62], [153, 62],
      [78, 78],  [153, 78],
      [54, 94],  [178, 94],
    ];
    ctx.fillStyle = 'rgba(20,35,65,0.75)';
    for (const [bx, by] of birds) {
      ctx.beginPath();
      ctx.moveTo(bx - 10, by + 1);
      ctx.quadraticCurveTo(bx - 6, by - 5, bx,     by + 2);
      ctx.quadraticCurveTo(bx + 6, by - 5, bx + 10, by + 1);
      ctx.quadraticCurveTo(bx + 4, by + 4, bx,     by + 2);
      ctx.quadraticCurveTo(bx - 4, by + 4, bx - 10, by + 1);
      ctx.closePath();
      ctx.fill();
    }

    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, fog: false,
    });
    const flock = new THREE.Sprite(mat);
    flock.scale.set(110, 55, 1);
    flock.position.set(-280, 52, -420);
    this._flock = flock;
    this.scene.add(flock);
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

    // Slide infinite environment pieces with the creature
    if (this._waterMesh) { this._waterMesh.position.x = c.x; this._waterMesh.position.z = c.z; }
    if (this._gridMesh) {
      const cell = this._gridCell;
      this._gridMesh.position.x = Math.round(c.x / cell) * cell;
      this._gridMesh.position.z = Math.round(c.z / cell) * cell;
    }
    if (this._clouds) { this._clouds.position.x = c.x; this._clouds.position.z = c.z; }
    if (this._sun) {
      this._sun.position.copy(SUN_DIR).multiplyScalar(1600)
        .add(new THREE.Vector3(c.x, 0, c.z));
    }
    if (this._mountains) { this._mountains.position.x = c.x; this._mountains.position.z = c.z; }
    if (this._flock) { this._flock.position.set(c.x - 280, 52, c.z - 420); }

    // Slide shadow camera so it always covers the area around the creature
    if (this._sunLight) {
      this._sunLight.position.copy(SUN_DIR).multiplyScalar(200)
        .add(new THREE.Vector3(c.x, 0, c.z));
      this._sunLight.target.position.set(c.x, 0, c.z);
      this._sunLight.target.updateMatrixWorld();
    }

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
        if (s.position.x > 850) s.position.x -= 1700;
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
