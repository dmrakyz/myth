// Bootstrap: error logging, load assets, init physics+renderer, RAF loop.
import * as THREE from 'three';
import { registerBuiltinProfiles } from './fluid/BluntBodyData.js';
import { AirfoilData } from './fluid/AirfoilData.js';
import { WaterSurface } from './fluid/WaterSurface.js';
import { FluidMedium } from './fluid/FluidMedium.js';
import { PhysicsWorld } from './physics/PhysicsWorld.js';
import { Vec3 } from './math/Vec3.js';
import { Renderer } from './renderer/Renderer.js';
import { CreatureRenderer } from './renderer/CreatureRenderer.js';
import { KeyboardControls } from './controls/KeyboardControls.js';
import { VirtualJoystick } from './controls/VirtualJoystick.js';
import { HUD } from './ui/HUD.js';
import { AttitudeIndicator } from './ui/AttitudeIndicator.js';
import { Builder } from './ui/Builder.js';

// ── On-screen error log ────────────────────────────────────────────────────
const errPanel = document.createElement('div');
errPanel.id = 'err-panel';
Object.assign(errPanel.style, {
  position: 'fixed', top: 'calc(96px + env(safe-area-inset-top, 0px))',
  left: '8px', right: '8px', zIndex: '9999',
  maxHeight: '30vh', overflowY: 'auto', pointerEvents: 'none',
});
document.body.appendChild(errPanel);

function logErr(msg, stack = '') {
  const el = document.createElement('div');
  Object.assign(el.style, {
    background: 'rgba(180,0,30,0.92)', color: '#fff',
    fontFamily: 'monospace', fontSize: '11px', padding: '6px 8px',
    marginTop: '4px', borderRadius: '4px', whiteSpace: 'pre-wrap',
    wordBreak: 'break-all', pointerEvents: 'auto',
  });
  el.textContent = '✕ ' + msg + (stack ? '\n' + stack.split('\n').slice(0, 4).join('\n') : '');
  el.addEventListener('click', () => el.remove());  // tap to dismiss
  errPanel.appendChild(el);
  console.error(msg, stack);
}

window.addEventListener('error', e => logErr(`[JS] ${e.message}`, e.error?.stack));
window.addEventListener('unhandledrejection', e => logErr(`[Promise] ${e.reason?.message || e.reason}`, e.reason?.stack));

// ── Loading helpers ─────────────────────────────────────────────────────────
const loadingEl = document.getElementById('loading');
const loadingFill = document.getElementById('loading-fill');

function setProgress(pct, label) {
  if (loadingFill) loadingFill.style.width = pct + '%';
  const statusEl = document.getElementById('loading-status');
  if (label) { console.log(`[boot] ${label}`); if (statusEl) statusEl.textContent = label; }
}

function hideLoading() {
  if (loadingEl) {
    loadingEl.classList.add('fade');
    setTimeout(() => { loadingEl.style.display = 'none'; }, 500);
  }
}

// ── Global state ────────────────────────────────────────────────────────────
let world, bird, renderer, creatureRenderer, hud, attitude, terrain, builder;
let keyboard, joystickL, joystickR;
let simMode = false;  // false = build view, true = simulate
let autoFlap = true;  // sustained flapping toggle (FLAP button)
let landMode = false; // right joystick Y → brake/flare instead of flapRate
let rafId = null;
let lastTime = 0;

// ── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    setProgress(10, 'Initializing physics...');
    registerBuiltinProfiles();

    setProgress(30, 'Loading airfoils...');
    const airfoilFiles = [
      ['naca2412', 'assets/airfoil/naca2412.json'],
      ['naca0012', 'assets/airfoil/hydrofoil_naca0012.json'],
    ];
    for (const [id, path] of airfoilFiles) {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
      const table = await res.json();
      new AirfoilData(id, table);
    }

    setProgress(55, 'Building creature...');
    const { createBird } = await import('./creature/presets/Bird.js');
    const { Terrain } = await import('./terrain/Terrain.js');
    const { GroundController } = await import('./creature/GroundController.js');

    setProgress(70, 'Starting renderer...');
    const water = new WaterSurface({ level: -10 });
    const medium = new FluidMedium(water);
    terrain = new Terrain({ seaLevel: -10 });
    world = new PhysicsWorld({ waterSurface: water, fluidMedium: medium, terrain });

    bird = createBird();
    bird.placeAt(0, 30, 0);
    bird.setVelocity(0, 0, -8);
    bird.groundController = new GroundController(bird, terrain);
    world.addCreature(bird);
    world.input.flapRate = 1;

    renderer = new Renderer(document.getElementById('canvas-container'), water, terrain);
    creatureRenderer = new CreatureRenderer(renderer.scene, bird);

    hud = new HUD();
    attitude = new AttitudeIndicator('attitude');
    keyboard = new KeyboardControls();
    keyboard.onReset = () => {
      if (bird) { bird.placeAt(0, 30, 0); bird.setVelocity(0, 0, -8); world.input.flapRate = 1; }
    };
    joystickL = new VirtualJoystick('joystick-left', 'PITCH · ROLL');
    joystickR = new VirtualJoystick('joystick-right', 'YAW · FLAP');

    builder = new Builder({
      getCreature: () => bird,
      getRenderer: () => creatureRenderer,
    });
    builder.setToast(showToast);

    setProgress(100, 'Ready');
    wireUI();
    enterSimMode();
    hideLoading();

    lastTime = performance.now();
    raf();
  } catch (err) {
    logErr(`[boot] ${err.message}`, err.stack);
    setProgress(0, 'Error — see on-screen log');
  }
}

// ── RAF loop ────────────────────────────────────────────────────────────────
function raf() {
  rafId = requestAnimationFrame(raf);
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  if (simMode && world && bird) {
    // Map controls to world input. Pitch/roll/yaw are bidirectional (−1..1);
    // flap rate is 0..1. Stick up = pitch up / more flap.
    const kb = keyboard.state;
    const lx = joystickL.x, ly = joystickL.y;
    const rx = joystickR.x, ry = joystickR.y;

    world.input.pitchUp  = clampAxis(-ly + (kb.pitchUp  - kb.pitchDown));
    world.input.rollLeft = clampAxis(-lx + (kb.rollLeft - kb.rollRight));
    world.input.yawLeft  = clampAxis(-rx + (kb.yawLeft  - kb.yawRight));
    if (landMode) {
      // LAND mode: right stick Y controls brake/flare (pull down = brake);
      // flapRate stays at a low glide-idle unless FLAP toggle is off.
      world.input.flapRate = clamp01(autoFlap ? 0.25 : 0);
      world.input.brake    = clamp01(ry + (kb.brake ? 1 : 0));
    } else {
      world.input.flapRate = clamp01((autoFlap ? 1 : 0) - ry + kb.flap);
      world.input.brake    = kb.brake ? 1 : 0;
    }

    world.step(dt);

    hud.update(world, bird);
    attitude?.update(bird);
    creatureRenderer.update(world.lerpAlpha);
    renderer.followTarget(bird);
  } else if (bird && creatureRenderer && renderer) {
    // Build view: hold the creature in its rest pose (no physics step) and let
    // the orbit camera frame it so the builder can inspect/edit it live.
    creatureRenderer.update(1);
    renderer.followTarget(bird);
  }

  renderer.render();
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function clampAxis(v) { return Math.max(-1, Math.min(1, v)); }

// ── UI wiring ───────────────────────────────────────────────────────────────
const FLIGHT_SHOW_IDS = ['hud', 'attitude', 'joystick-left', 'joystick-right', 'flap-btn', 'land-btn'];

function enterSimMode() {
  simMode = true;
  document.getElementById('build-scene').classList.add('hidden');
  document.getElementById('top-bar').classList.remove('hidden');
  FLIGHT_SHOW_IDS.forEach(id => document.getElementById(id)?.classList.remove('hidden'));
}

function enterBuildMode() {
  simMode = false;
  if (bird) {
    bird.placeAt(0, 5, 0);
    bird.setVelocity(0, 0, 0);
    if (bird.flappingController) bird.flappingController.tuck = 0;
  }
  builder?.refresh();
  document.getElementById('top-bar').classList.add('hidden');
  FLIGHT_SHOW_IDS.forEach(id => document.getElementById(id)?.classList.add('hidden'));
  document.getElementById('build-scene').classList.remove('hidden');
}

function wireUI() {
  // Flight nav: Build button → enter build scene
  document.getElementById('mode-toggle')?.addEventListener('click', () => enterBuildMode());

  // Build scene: Fly button → reset creature and return to flight
  document.getElementById('build-fly-btn')?.addEventListener('click', () => {
    if (bird) { bird.placeAt(0, 30, 0); bird.setVelocity(0, 0, -8); world.input.flapRate = 1; }
    enterSimMode();
  });

  // Flap toggle
  document.getElementById('flap-btn')?.addEventListener('click', () => {
    autoFlap = !autoFlap;
    document.getElementById('flap-btn').classList.toggle('active', autoFlap);
  });

  // LAND mode toggle: right joystick Y → brake/flare, flapRate auto-idled
  document.getElementById('land-btn')?.addEventListener('click', () => {
    landMode = !landMode;
    document.getElementById('land-btn').classList.toggle('active', landMode);
    showToast(landMode ? 'LAND mode — right stick: brake' : 'FLY mode — right stick: flap');
  });

  // Reset
  document.getElementById('reset-btn')?.addEventListener('click', () => {
    if (bird) {
      bird.placeAt(0, 30, 0);
      bird.setVelocity(0, 0, -8);
      world.input.flapRate = 1;
    }
  });

  // Panel toggles (flight-mode info panels only)
  const panelMap = {
    'creature-btn': 'creature-panel',
    'physics-btn':  'physics-panel',
  };
  for (const [btnId, panelId] of Object.entries(panelMap)) {
    document.getElementById(btnId)?.addEventListener('click', () => {
      const panel = document.getElementById(panelId);
      if (!panel) return;
      const isOpen = !panel.classList.contains('hidden');
      document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      if (!isOpen) {
        panel.classList.remove('hidden');
        document.getElementById(btnId).classList.add('active');
      }
    });
  }
  // Panel close buttons (✕)
  document.querySelectorAll('.panel-close').forEach(btn => {
    const panelId = btn.dataset.close;
    btn.addEventListener('click', () => {
      document.getElementById(panelId)?.classList.add('hidden');
      // Deactivate the corresponding nav button
      for (const [btnId, pid] of Object.entries(panelMap)) {
        if (pid === panelId) document.getElementById(btnId)?.classList.remove('active');
      }
    });
  });

  // Creature presets
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      const label = preset.charAt(0).toUpperCase() + preset.slice(1);
      // Map preset id → its module path and factory export name.
      const presetModules = {
        bird: ['./creature/presets/Bird.js', 'createBird'],
        bat:  ['./creature/presets/Bat.js', 'createBat'],
      };
      const entry = presetModules[preset];
      if (!entry) {
        showToast(`${label} preset coming soon!`);
        return;
      }
      const [modPath, factoryName] = entry;
      Promise.all([
        import(modPath),
        import('./creature/GroundController.js'),
      ]).then(([mod, { GroundController }]) => {
        if (bird) world.removeCreature(bird);
        bird = mod[factoryName]();
        bird.placeAt(0, 30, 0);
        bird.setVelocity(0, 0, -8);
        bird.groundController = new GroundController(bird, terrain);
        world.addCreature(bird);
        creatureRenderer.init(bird);
        builder?.refresh();
        document.getElementById('creature-panel').classList.add('hidden');
        showToast(`${label} loaded`);
      }).catch(err => logErr(err.message, err.stack));
    });
  });

  // Physics sliders
  function bindSlider(id, valId, onChange) {
    const el = document.getElementById(id);
    const val = document.getElementById(valId);
    if (!el) return;
    el.addEventListener('input', () => {
      if (val) val.textContent = el.value;
      onChange(parseFloat(el.value));
    });
  }
  bindSlider('gravity', 'grav-val', v => { if (world) world.gravity = v; });
  bindSlider('time-scale', 'time-val', v => { if (world) world.timeScale = v; });
  bindSlider('wind-speed', 'wind-val', updateWind);
  bindSlider('wind-dir', 'winddir-val', updateWind);
  function updateWind() {
    const spd = parseFloat(document.getElementById('wind-speed')?.value || 0);
    const dir = parseFloat(document.getElementById('wind-dir')?.value || 0) * Math.PI / 180;
    if (world?.medium) {
      world.medium.windSpeed = spd;
      world.medium.windDir.set(-Math.sin(dir), 0, -Math.cos(dir));
    }
  }

  // Save / Load
  document.getElementById('save-btn')?.addEventListener('click', () => showToast('Save coming soon'));
  document.getElementById('load-btn')?.addEventListener('click', () => showToast('Load coming soon'));
  document.getElementById('export-btn')?.addEventListener('click', () => showToast('Export coming soon'));
  document.getElementById('import-btn')?.addEventListener('click', () => showToast('Import coming soon'));
}

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.getElementById('notifications').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

boot();
