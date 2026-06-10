// Keyboard flight controls.
// WASD = pitch/roll, QE = yaw, Space = flap, B = brake, Tab = mode toggle.
export class KeyboardControls {
  constructor() {
    this.state = {
      pitchUp: 0, pitchDown: 0,
      rollLeft: 0, rollRight: 0,
      yawLeft: 0, yawRight: 0,
      flap: 0, brake: 0,
    };
    this._keys = new Set();
    window.addEventListener('keydown', e => this._onKey(e, true));
    window.addEventListener('keyup',   e => this._onKey(e, false));
  }

  _onKey(e, down) {
    // Don't steal input from text fields
    if (e.target && e.target.tagName === 'INPUT') return;
    const v = down ? 1 : 0;
    switch (e.code) {
      case 'KeyW': this.state.pitchUp    = v; break;
      case 'KeyS': this.state.pitchDown  = v; break;
      case 'KeyA': this.state.rollLeft   = v; break;
      case 'KeyD': this.state.rollRight  = v; break;
      case 'KeyQ': this.state.yawLeft    = v; break;
      case 'KeyE': this.state.yawRight   = v; break;
      case 'Space': e.preventDefault(); this.state.flap = v; break;
      case 'KeyB': this.state.brake      = v; break;
    }
  }
}
