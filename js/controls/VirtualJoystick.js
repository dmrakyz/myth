// On-screen virtual joystick. Renders into an existing container div.
// Exposes .x and .y in [-1, 1].
const DEAD = 0.08;

export class VirtualJoystick {
  constructor(containerId, label = '') {
    this.x = 0;
    this.y = 0;
    this._touchId = null;
    this._cx = 0;
    this._cy = 0;

    const container = document.getElementById(containerId);
    if (!container) return;

    const size = 130;
    const knobSize = 46;

    // Container keeps its CSS positioning (fixed, bottom corners) — only
    // populate the inside.
    container.innerHTML = '';

    // Base ring
    const base = document.createElement('div');
    Object.assign(base.style, {
      position: 'absolute', inset: '0', borderRadius: '50%',
      border: '2px solid rgba(77,163,255,0.35)',
      background: 'rgba(10,20,40,0.45)',
    });
    container.appendChild(base);

    // Label under the stick
    if (label) {
      const lab = document.createElement('div');
      Object.assign(lab.style, {
        position: 'absolute', top: '100%', left: '0', right: '0',
        marginTop: '6px', textAlign: 'center',
        fontSize: '9px', letterSpacing: '2px', color: 'rgba(107,122,144,0.9)',
        pointerEvents: 'none',
      });
      lab.textContent = label;
      container.appendChild(lab);
    }

    // Knob
    const knob = document.createElement('div');
    Object.assign(knob.style, {
      position: 'absolute',
      width: knobSize + 'px', height: knobSize + 'px',
      borderRadius: '50%',
      background: 'rgba(77,163,255,0.65)',
      border: '2px solid rgba(77,163,255,0.9)',
      left: (size / 2 - knobSize / 2) + 'px',
      top:  (size / 2 - knobSize / 2) + 'px',
      transition: 'transform 0.05s',
      touchAction: 'none',
    });
    container.appendChild(knob);
    this._knob = knob;
    this._size = size;
    this._maxR = size / 2 - knobSize / 2 - 2;

    const getCenter = () => {
      const r = container.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    };

    container.addEventListener('touchstart', e => {
      e.preventDefault();
      if (this._touchId !== null) return;
      const t = e.changedTouches[0];
      this._touchId = t.identifier;
      const { cx, cy } = getCenter();
      this._cx = cx; this._cy = cy;
      this._move(t.clientX, t.clientY);
    }, { passive: false });

    window.addEventListener('touchmove', e => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._touchId) {
          e.preventDefault();
          this._move(t.clientX, t.clientY);
        }
      }
    }, { passive: false });

    window.addEventListener('touchend', e => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._touchId) {
          this._touchId = null;
          this.x = 0; this.y = 0;
          this._setKnob(0, 0);
        }
      }
    });
  }

  _move(cx, cy) {
    let dx = cx - this._cx;
    let dy = cy - this._cy;
    const dist = Math.hypot(dx, dy);
    if (dist > this._maxR) {
      dx *= this._maxR / dist;
      dy *= this._maxR / dist;
    }
    this._setKnob(dx, dy);
    const nx = dx / this._maxR;
    const ny = dy / this._maxR;
    this.x = Math.abs(nx) < DEAD ? 0 : nx;
    this.y = Math.abs(ny) < DEAD ? 0 : ny;
  }

  _setKnob(dx, dy) {
    if (!this._knob) return;
    const half = this._size / 2;
    const ks = parseInt(this._knob.style.width);
    this._knob.style.left = (half - ks / 2 + dx) + 'px';
    this._knob.style.top  = (half - ks / 2 + dy) + 'px';
  }
}
