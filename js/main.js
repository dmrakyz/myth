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
  if (label) console.log(`[boot] ${label}`);
}

function hideLoading() {
  if (loadingEl) {
    loadingEl.classList.add('fade');
    setTimeout(() => { loadingEl.style.display = 'none'; }, 500);
  }
}

// ── Global state ────────────────────────────────────────────────────────────
let world, bird, renderer, creatureRenderer, hud;
let keyboard, joystickL, joystickR;
let simMode = false;  // false = build view, true = simulate
let autoFlap = true;  // sustained flapping toggle (FLAP button)
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

    setProgress(70, 'Starting renderer...');
    const water = new WaterSurface({ level: -10 });
    const medium = new FluidMedium(water);
    world = new PhysicsWorld({ waterSurface: water, fluidMedium: medium });

    bird = createBird();
    bird.placeAt(0, 30, 0);
    bird.setVelocity(0, 0, -8);
    world.addCreature(bird);
    world.input.flapRate = 1;

    renderer = new Renderer(document.getElementById('canvas-container'), water);
    creatureRenderer = new CreatureRenderer(renderer.scene, bird);

    hud = new HUD();
    keyboard = new KeyboardControls();
    joystickL = new VirtualJoystick('joystick-left', 'PITCH · ROLL');
    joystickR = new VirtualJoystick('joystick-right', 'YAW · FLAP');

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
    world.input.flapRate = clamp01((autoFlap ? 1 : 0) - ry + kb.flap);
    world.input.brake    = kb.brake ? 1 : 0;

    world.step(dt);

    hud.update(world, bird);
    creatureRenderer.update(world.lerpAlpha);
    renderer.followTarget(bird);
  }

  renderer.render();
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function clampAxis(v) { return Math.max(-1, Math.min(1, v)); }

// ── UI wiring ───────────────────────────────────────────────────────────────
function enterSimMode() {
  simMode = true;
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('joystick-left').classList.remove('hidden');
  document.getElementById('joystick-right').classList.remove('hidden');
  document.getElementById('flap-btn')?.classList.remove('hidden');
  document.getElementById('launch-btn').classList.add('hidden');
  const btn = document.getElementById('mode-toggle');
  if (btn) btn.textContent = '🔧 Build';
}

function enterBuildMode() {
  simMode = false;
  document.getElementById('hud').classList.add('hidden');
  document.getElementById('joystick-left').classList.add('hidden');
  document.getElementById('joystick-right').classList.add('hidden');
  document.getElementById('flap-btn')?.classList.add('hidden');
  document.getElementById('launch-btn').classList.remove('hidden');
  const btn = document.getElementById('mode-toggle');
  if (btn) btn.textContent = '✈ Simulate';
}

function wireUI() {
  // Mode toggle
  document.getElementById('mode-toggle')?.addEventListener('click', () => {
    simMode ? enterBuildMode() : enterSimMode();
  });

  // Flap toggle
  document.getElementById('flap-btn')?.addEventListener('click', () => {
    autoFlap = !autoFlap;
    document.getElementById('flap-btn').classList.toggle('active', autoFlap);
  });

  // Launch button
  document.getElementById('launch-btn')?.addEventListener('click', () => {
    if (bird) {
      bird.placeAt(0, 30, 0);
      bird.setVelocity(0, 0, -8);
      world.input.flapRate = 1;
    }
    enterSimMode();
  });

  // Reset
  document.getElementById('reset-btn')?.addEventListener('click', () => {
    if (bird) {
      bird.placeAt(0, 30, 0);
      bird.setVelocity(0, 0, -8);
      world.input.flapRate = 1;
    }
  });

  // Panel toggles
  const panelMap = {
    'creature-btn': 'creature-panel',
    'physics-btn':  'physics-panel',
    'debug-btn':    'builder-panel',
  };
  for (const [btnId, panelId] of Object.entries(panelMap)) {
    document.getElementById(btnId)?.addEventListener('click', () => {
      const panel = document.getElementById(panelId);
      if (!panel) return;
      const isOpen = !panel.classList.contains('hidden');
      // Close all panels first
      document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
      if (!isOpen) panel.classList.remove('hidden');
    });
  }

  // Creature presets
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      if (preset !== 'bird') {
        showToast(`${preset.charAt(0).toUpperCase() + preset.slice(1)} preset coming soon!`);
        return;
      }
      // Reload bird
      import('./creature/presets/Bird.js').then(({ createBird }) => {
        if (bird) world.removeCreature(bird);
        bird = createBird();
        bird.placeAt(0, 30, 0);
        bird.setVelocity(0, 0, -8);
        world.addCreature(bird);
        creatureRenderer.init(bird);
        document.getElementById('creature-panel').classList.add('hidden');
        showToast('Bird loaded');
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
