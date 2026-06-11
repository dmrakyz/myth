import * as THREE from 'three';

// Sun direction (low golden-hour angle) shared by sky, water glitter, lighting.
const SUN_DIR = new THREE.Vector3(0.35, 0.22, 0.9).normalize();

export class Renderer {
  constructor(container, waterSurface, terrain = null) {
    this.container = container;
    this.waterSurface = waterSurface;
    this.terrain = terrain;
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

    // Environment. Real procedural terrain replaces the silhouette mountain
    // billboards and the horizon grid when a heightfield is provided.
    this._buildSky();
    this._buildSun();
    if (this.terrain) this._buildTerrain();
    else this._buildMountains();
    this._buildClouds();
    this._buildWater();
    if (!this.terrain) this._buildHorizonGrid();
    this._buildStars();
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

  // ── Volumetric cloud formations (3-5 overlapping sprites per cloud) ──────────
  _buildClouds() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    for (let i = 0; i < 14; i++) {
      const x = 55 + Math.random() * 146, y = 85 + Math.random() * 86;
      const r = 28 + Math.random() * 52;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.58)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.18)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 256);
    }
    const tex = new THREE.CanvasTexture(c);

    this._clouds = new THREE.Group();
    const tints = [0xfff4e8, 0xf0e0f0, 0xe0d0e8, 0xfff0d8];

    // 13 formations, each built from 3–5 overlapping sprites for a puffier look
    for (let i = 0; i < 13; i++) {
      const cx = (Math.random() - 0.5) * 1400;
      const cz = (Math.random() - 0.5) * 1400;
      const cy = 80 + Math.random() * 150;
      const baseScale = 55 + Math.random() * 110;
      const tint = tints[i % tints.length];
      const driftX = 0.8 + Math.random() * 1.8;
      const count = 3 + Math.floor(Math.random() * 3);
      for (let j = 0; j < count; j++) {
        const mat = new THREE.SpriteMaterial({
          map: tex, transparent: true,
          opacity: 0.30 + Math.random() * 0.28,
          color: tint, depthWrite: false,
        });
        const s = new THREE.Sprite(mat);
        const sc = baseScale * (0.65 + Math.random() * 0.70);
        s.scale.set(sc, sc * 0.48, 1);
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
          col = mix(col, skyTint, fres * 0.6);
          // specular sun glitter
          vec3 H = normalize(sunDir + V);
          float spec = pow(max(dot(N, H), 0.0), 120.0);
          col += vec3(1.0, 0.9, 0.7) * spec * 1.4;
          // foam at wave crests
          float foam = smoothstep(0.32, 0.68, vHeight);
          col = mix(col, vec3(0.88, 0.92, 0.95), foam * 0.44);
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

  // ── Procedural terrain mesh (matches the physics heightfield exactly) ────────
  _buildTerrain() {
    const SIZE = 3200, RES = 220;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, RES, RES);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const sea = this.terrain.seaLevel;
    const col = new THREE.Color();
    const sand = new THREE.Color(0xb8a87e);
    const wetSand = new THREE.Color(0x8a7a62);
    const grass = new THREE.Color(0x5e6e42);
    const scrub = new THREE.Color(0x77704a);
    const rock = new THREE.Color(0x6e6058);
    const snow = new THREE.Color(0xe6e2d8);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = this.terrain.height(x, z);
      pos.setY(i, h);
      const a = h - sea;   // height above sea level
      if (a < 0.5)       col.copy(wetSand);
      else if (a < 2.5)  col.copy(sand).lerp(wetSand, (2.5 - a) / 2);
      else if (a < 12)   col.copy(grass).lerp(sand, Math.max(0, (4 - a) / 1.5));
      else if (a < 22)   col.copy(scrub).lerp(grass, (22 - a) / 10);
      else if (a < 32)   col.copy(rock).lerp(scrub, (32 - a) / 10);
      else               col.copy(snow).lerp(rock, Math.max(0, (40 - a) / 8));
      // subtle deterministic variation breaks up flat banding
      const v = 0.92 + 0.08 * Math.abs(Math.sin(x * 12.9898 + z * 78.233));
      colors[i * 3] = col.r * v; colors[i * 3 + 1] = col.g * v; colors[i * 3 + 2] = col.b * v;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 4 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this._terrainMesh = mesh;
  }

  // ── Distant mountain silhouette ring ──────────────────────────────────────────
  _buildMountains() {
    const W = 2048, H = 256;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    // Two overlapping mountain ranges built from summed sines (deterministic, no Math.random)
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

    drawRange(118,  5,  9, 22, 0.88);  // far range — very dark navy
    drawRange( 68, 10, 16, 36, 0.92);  // near range — slightly lighter, shorter

    const tex = new THREE.CanvasTexture(c);

    this._mountains = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const angle = i * Math.PI / 2;
      // Each cardinal plane gets a different horizontal slice of the texture so
      // not all 4 faces look identical.
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

  // ── Distant bird flock silhouette ─────────────────────────────────────────────
  _buildFlock() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 256, 128);

    // V-formation of simplified gull silhouettes (M-shapes for spread wings)
    const birds = [
      [128, 46],
      [103, 62], [153, 62],
      [78, 78],  [153, 78],
      [54, 94],  [178, 94],
    ];
    ctx.fillStyle = 'rgba(12, 15, 32, 0.82)';
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
    if (this._mountains) { this._mountains.position.x = c.x; this._mountains.position.z = c.z; }
    if (this._flock) { this._flock.position.set(c.x - 280, 52, c.z - 420); }

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
