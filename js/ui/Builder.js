import { Vec3 } from '../math/Vec3.js';
import { Segment } from '../creature/Segment.js';

// Live creature builder. Renders the current creature's part graph into the
// builder panel and lets you select a segment to edit its properties (shape,
// size, mass, aero profile, colour, position) with the changes applied
// straight to the running creature and reflected in the 3D view. Also adds
// and deletes segments.
//
// Joints, muscles, wings, feather arrays and membranes are listed read-only
// for now — editing those needs pivot/gizmo tooling, the natural next step.
const SHAPES = ['ellipsoid', 'box', 'capsule', 'plate'];
const PROFILES = ['bluntbody', 'streamlined'];
const HIGHLIGHT = 0x4da3ff;

function hex(n) { return '#' + (n & 0xffffff).toString(16).padStart(6, '0'); }
function fmt(v) { return Number.isFinite(v) ? (Math.round(v * 1000) / 1000).toString() : '0'; }

export class Builder {
  constructor({ getCreature, getRenderer, onStructureChange = () => {} }) {
    this.getCreature = getCreature;
    this.getRenderer = getRenderer;
    this.onStructureChange = onStructureChange;
    this.selectedId = null;
    this._savedEmissive = null;

    this.toolbar = document.getElementById('builder-toolbar');
    this.props = document.getElementById('builder-props');
    this._wireToolbar();
  }

  _wireToolbar() {
    this.toolbar?.querySelectorAll('.tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        if (tool === 'segment') { this.addSegment(); return; }
        if (tool === 'select') {
          this.toolbar.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          return;
        }
        // The remaining add-tools (wing bone, feathers, membrane, fin, joint,
        // muscle) need pivot/anchor placement that isn't wired yet.
        this._toast?.(`"${btn.textContent.trim()}" tool isn't implemented yet — edit segments for now`);
      });
    });
  }

  setToast(fn) { this._toast = fn; }

  // Rebuild the part tree (called on open and after structural edits)
  refresh() {
    const c = this.getCreature();
    if (!c || !this.props) return;
    // Drop a stale selection
    if (this.selectedId && !c.segments.has(this.selectedId)) this.selectedId = null;

    const parts = [];
    parts.push(this._treeSection('Segments', [...c.segments.values()].map(s => ({
      id: s.id, label: `${s.name}  ·  ${s.shape}`, selectable: true,
      tag: s.id === c.rootSegmentId ? 'root' : '',
    }))));
    parts.push(this._countSection('Joints', c.joints.size));
    parts.push(this._countSection('Muscles', c.muscles.size));
    parts.push(this._countSection('Wings', c.wings.size));
    parts.push(this._countSection('Feather arrays', c.featherArrays.size));
    parts.push(this._countSection('Membranes', c.membranes.size));

    this.props.innerHTML =
      parts.join('') +
      (this.selectedId ? this._inspector(c.segments.get(this.selectedId)) : '');

    this.props.querySelectorAll('[data-seg]').forEach(row => {
      row.addEventListener('click', () => this.select(row.dataset.seg));
    });
    if (this.selectedId) this._wireInspector(c.segments.get(this.selectedId));
    this._applyHighlight();
  }

  _treeSection(title, items) {
    const rows = items.map(it =>
      `<div class="builder-row${it.id === this.selectedId ? ' sel' : ''}" data-seg="${it.id}">
         <span>${it.label}</span>${it.tag ? `<span class="builder-tag">${it.tag}</span>` : ''}
       </div>`).join('') || `<div class="builder-hint">none</div>`;
    return `<div class="prop-group"><div class="prop-group-title">${title}</div>${rows}</div>`;
  }

  _countSection(title, n) {
    return `<div class="prop-group"><div class="prop-group-title">${title}</div>
      <div class="builder-hint">${n} (read-only)</div></div>`;
  }

  _inspector(seg) {
    if (!seg) return '';
    const d = seg.dimensions;
    const opt = (list, sel) => list.map(v => `<option value="${v}"${v === sel ? ' selected' : ''}>${v}</option>`).join('');
    const p = seg.rigidBody.position;
    return `<div class="prop-group">
      <div class="prop-group-title">Edit: ${seg.name}</div>
      <div class="prop-row"><label>Name</label><input data-p="name" type="text" value="${seg.name}"></div>
      <div class="prop-row"><label>Shape</label><select data-p="shape">${opt(SHAPES, seg.shape)}</select></div>
      <div class="prop-row"><label>Size X</label><input data-p="d0" type="number" step="0.005" value="${fmt(d[0])}"></div>
      <div class="prop-row"><label>Size Y</label><input data-p="d1" type="number" step="0.005" value="${fmt(d[1] ?? 0)}"></div>
      <div class="prop-row"><label>Size Z</label><input data-p="d2" type="number" step="0.005" value="${fmt(d[2] ?? 0)}"></div>
      <div class="prop-row"><label>Mass</label><input data-p="mass" type="number" step="0.005" min="0.001" value="${fmt(seg.mass)}"></div>
      <div class="prop-row"><label>Aero</label><select data-p="aero">${opt(PROFILES, seg.aeroProfile)}</select></div>
      <div class="prop-row"><label>Colour</label><input data-p="color" type="color" value="${hex(seg.color)}"></div>
      <div class="prop-row"><label>Pos X</label><input data-p="px" type="number" step="0.01" value="${fmt(p.x)}"></div>
      <div class="prop-row"><label>Pos Y</label><input data-p="py" type="number" step="0.01" value="${fmt(p.y)}"></div>
      <div class="prop-row"><label>Pos Z</label><input data-p="pz" type="number" step="0.01" value="${fmt(p.z)}"></div>
      <div class="prop-actions"><button class="danger" data-act="del">Delete segment</button></div>
    </div>`;
  }

  _wireInspector(seg) {
    if (!seg) return;
    const get = p => this.props.querySelector(`[data-p="${p}"]`);
    const onChange = (p, fn) => { const el = get(p); el?.addEventListener('input', () => fn(el.value)); };

    onChange('name', v => { seg.name = v || seg.name; });
    onChange('shape', v => { seg.setShape(v, seg.dimensions); this._rebuild(); });
    const applyDims = () => {
      const dims = ['d0', 'd1', 'd2'].map(k => parseFloat(get(k).value) || 0);
      seg.setShape(seg.shape, dims);
      this._rebuild();
    };
    ['d0', 'd1', 'd2'].forEach(k => get(k)?.addEventListener('input', applyDims));
    onChange('mass', v => { const m = parseFloat(v); if (m > 0) seg.setMass(m); });
    onChange('aero', v => seg.setAeroProfile(v));
    onChange('color', v => {
      seg.color = parseInt(v.slice(1), 16);
      const mesh = this.getRenderer()?.segMeshes.get(seg.id);
      if (mesh) mesh.material.color.set(seg.color);
      this._applyHighlight();   // keeps the selection glow on the edited mesh
    });
    const applyPos = () => {
      const rb = seg.rigidBody;
      rb.position.set(parseFloat(get('px').value) || 0, parseFloat(get('py').value) || 0, parseFloat(get('pz').value) || 0);
      rb.snapshotPrev();
      rb.updateDerived();
    };
    ['px', 'py', 'pz'].forEach(k => get(k)?.addEventListener('input', applyPos));

    this.props.querySelector('[data-act="del"]')
      ?.addEventListener('click', () => this.deleteSegment(seg.id));
  }

  select(id) {
    this.selectedId = id;
    this.refresh();
  }

  _applyHighlight() {
    const r = this.getRenderer();
    if (!r) return;
    // Restore everything to its base emissive, then boost the selected one.
    for (const [id, mesh] of r.segMeshes) {
      const c = this.getCreature().segments.get(id);
      if (c) mesh.material.emissive.set(c.color).multiplyScalar(0.07);
    }
    if (this.selectedId) {
      const mesh = r.segMeshes.get(this.selectedId);
      if (mesh) mesh.material.emissive.set(HIGHLIGHT).multiplyScalar(0.55);
    }
  }

  _rebuild() {
    const r = this.getRenderer();
    r?.init(this.getCreature());
    r?.update(1);
    this._applyHighlight();
    this.onStructureChange();
  }

  addSegment() {
    const c = this.getCreature();
    const cen = c.getCentroid();
    const seg = new Segment({
      name: `segment${c.segments.size + 1}`,
      shape: 'ellipsoid', dimensions: [0.04, 0.04, 0.04], mass: 0.03,
      position: new Vec3(cen.x, cen.y + 0.15, cen.z), color: 0x88aa88,
    });
    c.addSegment(seg);
    this.selectedId = seg.id;
    this._rebuild();
    this.refresh();
    this._toast?.(`Added ${seg.name}`);
  }

  deleteSegment(id) {
    const c = this.getCreature();
    if (id === c.rootSegmentId) { this._toast?.('Cannot delete the root segment'); return; }

    // Drop anything anchored to this segment so the physics graph stays valid.
    const deadJoints = [];
    for (const [jid, meta] of c.jointMeta) {
      if (meta.segA === id || meta.segB === id) deadJoints.push(jid);
    }
    for (const jid of deadJoints) { c.joints.delete(jid); c.jointMeta.delete(jid); }
    for (const [mid, meta] of c.muscleMeta) {
      if (deadJoints.includes(meta.jointId)) { c.muscles.delete(mid); c.muscleMeta.delete(mid); }
    }
    for (const [wid, w] of c.wings) if (w.segmentId === id) c.wings.delete(wid);
    for (const [fid, fa] of c.featherArrays) if (fa.segmentId === id) c.featherArrays.delete(fid);
    for (const [memId, m] of c.membranes) {
      if (m.pins?.some(p => p.segment.id === id)) c.membranes.delete(memId);
    }
    c.segments.delete(id);

    this.selectedId = null;
    this._rebuild();
    this.refresh();
    this._toast?.('Segment deleted');
  }
}
