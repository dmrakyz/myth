// Canvas artificial horizon + heading + vertical-speed readout. Reads the
// root body orientation each frame so you can always see what the bird is
// doing: pitch ladder, bank angle, heading, and climb/sink rate.
import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';

const FWD = new Vec3(0, 0, -1), UP = new Vec3(0, 1, 0), RIGHT = new Vec3(1, 0, 0);
const fwdW = new Vec3(), upW = new Vec3(), rightW = new Vec3();

export class AttitudeIndicator {
  constructor(containerId) {
    const host = document.getElementById(containerId);
    if (!host) return;
    const size = 104;
    this.size = size;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const canvas = document.createElement('canvas');
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = canvas.style.height = size + 'px';
    host.appendChild(canvas);
    this.ctx = canvas.getContext('2d');
    this.ctx.scale(dpr, dpr);

    // Heading + VSI text under the dial
    const label = document.createElement('div');
    label.className = 'adi-readout';
    label.innerHTML =
      '<span><b id="adi-hdg">000</b>°<small>HDG</small></span>' +
      '<span><b id="adi-vsi">0.0</b><small>m/s</small></span>';
    host.appendChild(label);
    this._hdg = label.querySelector('#adi-hdg');
    this._vsi = label.querySelector('#adi-vsi');
  }

  update(creature) {
    if (!this.ctx || !creature?.root) return;
    const rb = creature.root.rigidBody;
    Quat.rotateVec(rb.orientation, FWD, fwdW);
    Quat.rotateVec(rb.orientation, UP, upW);
    Quat.rotateVec(rb.orientation, RIGHT, rightW);

    const pitch = Math.asin(Math.max(-1, Math.min(1, fwdW.y)));    // + nose up
    const roll = Math.atan2(rightW.y, upW.y);                       // + right wing up
    let heading = Math.atan2(fwdW.x, -fwdW.z) * 57.2958;            // 0 = −Z
    heading = ((heading % 360) + 360) % 360;

    this._draw(pitch, roll);
    if (this._hdg) this._hdg.textContent = String(Math.round(heading)).padStart(3, '0');
    if (this._vsi) {
      const vy = rb.velocity.y;
      this._vsi.textContent = (vy >= 0 ? '+' : '') + vy.toFixed(1);
      this._vsi.style.color = vy > 0.3 ? '#4dffaa' : vy < -0.3 ? '#ff8c5a' : '#cdd6e4';
    }
  }

  _draw(pitch, roll) {
    const ctx = this.ctx, s = this.size, r = s / 2 - 4, cx = s / 2, cy = s / 2;
    ctx.clearRect(0, 0, s, s);
    ctx.save();
    // Circular clip
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();

    // Horizon ball: roll then pitch (10° ≈ r*0.16 px)
    const pxPerRad = r / (50 * Math.PI / 180); // full ±25° fills the dial
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-roll);
    const pitchOff = pitch * pxPerRad;

    // Sky
    const sky = ctx.createLinearGradient(0, -s, 0, pitchOff);
    sky.addColorStop(0, '#2a6db0');
    sky.addColorStop(1, '#7fb5e6');
    ctx.fillStyle = sky;
    ctx.fillRect(-s, -s * 1.5 + pitchOff, s * 2, s * 1.5);
    // Ground
    const grd = ctx.createLinearGradient(0, pitchOff, 0, s);
    grd.addColorStop(0, '#9a6a3a');
    grd.addColorStop(1, '#5a3a1e');
    ctx.fillStyle = grd;
    ctx.fillRect(-s, pitchOff, s * 2, s * 1.5);
    // Horizon line
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-s, pitchOff);
    ctx.lineTo(s, pitchOff);
    ctx.stroke();
    // Pitch ladder
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.lineWidth = 1;
    for (let deg = -20; deg <= 20; deg += 10) {
      if (deg === 0) continue;
      const y = pitchOff - deg * pxPerRad;
      const w = deg % 20 === 0 ? 16 : 9;
      ctx.beginPath();
      ctx.moveTo(-w, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.restore();

    // Fixed aircraft reference (wings + dot)
    ctx.strokeStyle = '#ffd24d';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx - 22, cy); ctx.lineTo(cx - 8, cy);
    ctx.moveTo(cx + 8, cy); ctx.lineTo(cx + 22, cy);
    ctx.moveTo(cx, cy - 2); ctx.lineTo(cx, cy + 2);
    ctx.stroke();
    ctx.restore();

    // Roll arc ticks + bank pointer
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const rad = a * Math.PI / 180;
      const len = a % 30 === 0 ? 6 : 3;
      ctx.beginPath();
      ctx.moveTo(Math.sin(rad) * r, -Math.cos(rad) * r);
      ctx.lineTo(Math.sin(rad) * (r - len), -Math.cos(rad) * (r - len));
      ctx.stroke();
    }
    // Bank pointer (rolls with the bird)
    ctx.rotate(-roll);
    ctx.fillStyle = '#ffd24d';
    ctx.beginPath();
    ctx.moveTo(0, -r + 1);
    ctx.lineTo(-4, -r + 8);
    ctx.lineTo(4, -r + 8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Bezel
    ctx.strokeStyle = 'rgba(77,163,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}
