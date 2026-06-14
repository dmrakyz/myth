// Builder graph-mutation test: deleting a segment must leave a consistent
// creature graph (no joint/muscle/wing/membrane left dangling). Uses a minimal
// DOM stub so the Builder can run headless. Run: node test/builder_test.mjs
import { registerBuiltinProfiles } from '../js/fluid/BluntBodyData.js';
import { AirfoilData } from '../js/fluid/AirfoilData.js';
import { readFile } from 'fs/promises';

// --- Minimal DOM stub (Builder only needs getElementById + element no-ops) ---
const fakeEl = () => ({
  _html: '',
  set innerHTML(v) { this._html = v; },
  get innerHTML() { return this._html; },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
});
global.document = { getElementById: () => fakeEl() };

registerBuiltinProfiles();
for (const id of ['naca2412', 'hydrofoil_naca0012']) {
  const table = JSON.parse(await readFile(new URL(`../assets/airfoil/${id}.json`, import.meta.url)));
  new AirfoilData(id === 'hydrofoil_naca0012' ? 'naca0012' : id, table);
}

const { createBird } = await import('../js/creature/presets/Bird.js');
const { createBat } = await import('../js/creature/presets/Bat.js');
const { Builder } = await import('../js/ui/Builder.js');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

function assertConsistent(c, label) {
  let ok = true, why = '';
  for (const [jid, meta] of c.jointMeta) {
    if (!c.segments.has(meta.segA) || !c.segments.has(meta.segB)) { ok = false; why = `joint ${jid} dangling`; }
  }
  for (const [mid, meta] of c.muscleMeta) {
    if (!c.joints.has(meta.jointId)) { ok = false; why = `muscle ${mid} → missing joint`; }
  }
  for (const w of c.wings.values()) {
    if (!c.segments.has(w.segmentId)) { ok = false; why = `wing ${w.name} → missing segment`; }
  }
  for (const fa of c.featherArrays.values()) {
    if (!c.segments.has(fa.segmentId)) { ok = false; why = `feathers ${fa.id} → missing segment`; }
  }
  for (const m of c.membranes.values()) {
    if (m.pins?.some(p => !c.segments.has(p.segment.id))) { ok = false; why = `membrane ${m.id} pinned to missing segment`; }
  }
  check(`${label}: graph consistent`, ok, why);
}

// --- Bird: delete a wing's hand bone, verify dependents are cleaned up ---
{
  const bird = createBird();
  const builder = new Builder({ getCreature: () => bird, getRenderer: () => null });
  const hand = bird.findSegmentByName('handR');
  const segBefore = bird.segments.size, jointBefore = bird.joints.size;
  builder.deleteSegment(hand.id);
  check('hand segment removed', !bird.segments.has(hand.id));
  check('wrist joint removed with it', !bird.joints.has('wristR'));
  check('primaries feather array removed', ![...bird.featherArrays.values()].some(fa => fa.segmentId === hand.id));
  check('segment count dropped', bird.segments.size === segBefore - 1, `${bird.segments.size} vs ${segBefore}`);
  check('joint count dropped', bird.joints.size < jointBefore);
  assertConsistent(bird, 'bird after delete');
}

// --- Bird: cannot delete the root ---
{
  const bird = createBird();
  const builder = new Builder({ getCreature: () => bird, getRenderer: () => null });
  const before = bird.segments.size;
  builder.deleteSegment(bird.rootSegmentId);
  check('root delete refused', bird.segments.size === before);
}

// --- Bird: add a segment ---
{
  const bird = createBird();
  const builder = new Builder({ getCreature: () => bird, getRenderer: () => null });
  const before = bird.segments.size;
  builder.addSegment();
  check('segment added', bird.segments.size === before + 1);
  check('new segment selected', builder.selectedId && bird.segments.has(builder.selectedId));
}

// --- Bat: delete an arm bone, membrane pinned to it must go too ---
{
  const bat = createBat();
  const builder = new Builder({ getCreature: () => bat, getRenderer: () => null });
  const arm = bat.findSegmentByName('armR');
  const memBefore = bat.membranes.size;
  builder.deleteSegment(arm.id);
  check('arm segment removed', !bat.segments.has(arm.id));
  check('membrane pinned to arm removed', bat.membranes.size < memBefore, `${bat.membranes.size} vs ${memBefore}`);
  assertConsistent(bat, 'bat after delete');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
