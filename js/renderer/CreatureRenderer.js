import * as THREE from 'three';

// Physics → Three.js mesh sync.
// Segments: colored ellipsoid/box meshes.
// Wing strips: thin semi-transparent quads (shows wing surface).
// Feathers: tapered quads with passive pitch applied.

const _q = new THREE.Quaternion();
const _bodyQ = new THREE.Quaternion();
const _localQ = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _vx = new THREE.Vector3();
const _vy = new THREE.Vector3();
const _vz = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();

// Rotate a body-local point by a quaternion into world space (add body pos after).
function rotByQuat(qb, bx, by, bz) {
  // Active rotation: q * v * q^-1
  const { x: qx, y: qy, z: qz, w: qw } = qb;
  const tx = 2 * (qy * bz - qz * by);
  const ty = 2 * (qz * bx - qx * bz);
  const tz = 2 * (qx * by - qy * bx);
  return {
    x: bx + qw * tx + qy * tz - qz * ty,
    y: by + qw * ty + qz * tx - qx * tz,
    z: bz + qw * tz + qx * ty - qy * tx,
  };
}

// Build a quaternion that maps +X→chord, +Y→span (PlaneGeometry is in local XY).
function quatFromFrame(chordDir, spanDir) {
  _vx.set(chordDir.x, chordDir.y, chordDir.z).normalize();
  _vy.set(spanDir.x, spanDir.y, spanDir.z).normalize();
  _vz.crossVectors(_vx, _vy).normalize();
  _mat4.makeBasis(_vx, _vy, _vz);
  return new THREE.Quaternion().setFromRotationMatrix(_mat4);
}

function makeSegmentMesh(seg) {
  const d = seg.dimensions;
  let geo;
  switch (seg.shape) {
    case 'ellipsoid': {
      geo = new THREE.SphereGeometry(1, 14, 10);
      geo.applyMatrix4(new THREE.Matrix4().makeScale(d[0], d[1], d[2]));
      break;
    }
    case 'box':
      geo = new THREE.BoxGeometry(d[0] * 2, d[1] * 2, d[2] * 2);
      break;
    case 'capsule':
      geo = new THREE.CapsuleGeometry(d[0], d[1] ?? d[0], 6, 10);
      break;
    case 'plate':
      geo = new THREE.BoxGeometry(d[1], 0.003, d[0]);
      break;
    default:
      geo = new THREE.SphereGeometry(0.05, 8, 6);
  }
  const color = new THREE.Color(seg.color ?? 0x8a7a66);
  const mat = new THREE.MeshPhongMaterial({
    color, emissive: color.clone().multiplyScalar(0.07), shininess: 25,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  return mesh;
}

function makeStripMesh(strip, wingName = '') {
  const geo = new THREE.PlaneGeometry(strip.chord, strip.span);
  let baseColor;
  if (wingName.startsWith('innerWing'))    baseColor = 0x9a8870;
  else if (wingName.startsWith('tertials')) baseColor = 0x8a7860;
  else if (wingName.startsWith('alula'))   baseColor = 0xc0ac88;
  else                                      baseColor = 0xc8b89a;
  const color = new THREE.Color(baseColor);
  const mat = new THREE.MeshPhongMaterial({
    color, emissive: color.clone().multiplyScalar(0.05),
    side: THREE.DoubleSide, transparent: true, opacity: 0.62, shininess: 50,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.userData.localQ = quatFromFrame(strip.chordDir, strip.spanDir);
  return mesh;
}

function makeFeatherMesh(feather, index = 0, total = 1) {
  const s = feather.surface;
  // Render the vane wider than the aerodynamic chord so the swept primaries
  // overlap into a continuous surface (real flight feathers shingle ~50%)
  // instead of a thin gappy rake. Visual only — the BET chord is unchanged.
  const geo = new THREE.PlaneGeometry(s.chord * 1.6, s.span);
  // Inner primaries darker/warmer, outer primaries lighter/cooler
  const t = index / Math.max(total - 1, 1);
  const color = new THREE.Color(0xc8b890).lerp(new THREE.Color(0xf0ece4), t);
  const mat = new THREE.MeshPhongMaterial({
    color, emissive: color.clone().multiplyScalar(0.04),
    side: THREE.DoubleSide, transparent: true, opacity: 0.84, shininess: 12,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.userData.localQ = quatFromFrame(s.chordDir, s.spanDir);
  return mesh;
}

// Membrane wing: a triangle mesh over the cloth grid. The cloth particles
// live in WORLD space (ClothBody.pos), so the mesh sits at the group origin
// and we write absolute positions straight into its vertex buffer each frame.
// Both faces are lit (DoubleSide) and normals are recomputed per frame so the
// billow shades correctly as the membrane deforms.
function makeMembraneMesh(mem) {
  const { cols, rows } = mem;
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(new Float32Array(cols * rows * 3), 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);

  // Two triangles per grid cell
  const idx = (c, r) => r * cols + c;
  const indices = [];
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const i00 = idx(c, r), i10 = idx(c + 1, r);
      const i01 = idx(c, r + 1), i11 = idx(c + 1, r + 1);
      indices.push(i00, i10, i11, i00, i11, i01);
    }
  }
  geo.setIndex(indices);

  const color = new THREE.Color(mem.color ?? 0x6b4a3a);
  const mat = new THREE.MeshPhongMaterial({
    color, emissive: color.clone().multiplyScalar(0.06),
    side: THREE.DoubleSide, transparent: true, opacity: 0.9, shininess: 8,
    flatShading: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  // Cloth positions are world-space; keep the mesh at identity.
  mesh.matrixAutoUpdate = false;
  return { mesh, geo, posAttr };
}

// Scratch for the wing-fold pose
const _fT = new THREE.Quaternion();
const _fA = new THREE.Quaternion();
const _fH = new THREE.Quaternion();
const _fTmpQ = new THREE.Quaternion();
const _fV = new THREE.Vector3();
const _fV2 = new THREE.Vector3();
const _AXIS_Y = new THREE.Vector3(0, 1, 0);
const _AXIS_Z = new THREE.Vector3(0, 0, 1);

export class CreatureRenderer {
  constructor(scene, creature) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.segMeshes = new Map();
    this.stripEntries = [];    // { strip, segId, mesh }
    this.featherEntries = [];  // { feather, segId, mesh }
    this.creature = null;
    this.init(creature);
  }

  init(creature) {
    this.group.clear();
    this.segMeshes.clear();
    this.stripEntries.length = 0;
    this.featherEntries.length = 0;
    this.attachEntries = [];    // { att, mesh }
    this.coverts = [];          // { vf, mesh } static decorative feather quads
    this.membraneEntries = [];  // { mem, mesh, geo, posAttr } cloth wing surfaces
    this.tailFan = null;        // { segId, meshes[], cfg }
    this.creature = creature;

    for (const [id, seg] of creature.segments) {
      // The tail plate is replaced visually by the rectrix fan below
      if (creature.tailFanVisual && id === creature.tailFanVisual.segId) continue;
      const mesh = makeSegmentMesh(seg);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.segMeshes.set(id, mesh);
    }

    for (const wing of creature.wings.values()) {
      // tailSurface duplicates the tail plate segment; tailFin models the
      // splayed tail's side area at sideslip — neither is a visible surface.
      if (wing.name === 'tailSurface' || wing.name === 'tailFin') continue;
      for (const strip of wing.strips) {
        const mesh = makeStripMesh(strip, wing.name);
        mesh.frustumCulled = false;
        this.group.add(mesh);
        this.stripEntries.push({ strip, segId: wing.segmentId, mesh });
      }
    }

    for (const fa of creature.featherArrays.values()) {
      const total = fa.feathers.length;
      for (let fi = 0; fi < total; fi++) {
        const feather = fa.feathers[fi];
        const mesh = makeFeatherMesh(feather, fi, total);
        mesh.frustumCulled = false;
        this.group.add(mesh);
        this.featherEntries.push({ feather, segId: fa.segmentId, mesh });
      }
    }

    for (const att of creature.visualAttachments ?? []) {
      const mesh = makeSegmentMesh({ shape: att.shape, dimensions: att.dimensions, color: att.color });
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      this.group.add(mesh);
      this.attachEntries.push({ att, mesh });
    }

    // Covert rows / decorative feather quads
    for (const vf of creature.visualFeathers ?? []) {
      const geo = new THREE.PlaneGeometry(vf.chord, vf.span);
      const color = new THREE.Color(vf.color);
      const mat = new THREE.MeshPhongMaterial({
        color, emissive: color.clone().multiplyScalar(0.05),
        side: THREE.DoubleSide, transparent: true, opacity: 0.9, shininess: 18,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.userData.localQ = quatFromFrame({ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 });
      this.group.add(mesh);
      this.coverts.push({ vf, mesh });
    }

    // Membrane wings (bat/dragon): one deforming triangle mesh per cloth grid.
    for (const mem of creature.membranes.values()) {
      const entry = makeMembraneMesh(mem);
      this.group.add(entry.mesh);
      this.membraneEntries.push({ mem, ...entry });
    }

    // Wing-fold rig: birds fold the wing into a Z against the body when they
    // land (humerus sweeps back, hand folds back over the tail). The physics
    // rig has no sweep DOF — only flap hinges — so the fold is a visual pose
    // blended in by the physical tuck signal. Each side caches its bones and
    // joints; the folded pose is rebuilt from the joint pivots every frame so
    // it follows the torso on any slope.
    this.foldSides = [];
    this.foldPose = new Map();   // segId → { p: Vector3, q: Quaternion }
    for (const side of ['R', 'L']) {
      const arm = creature.findSegmentByName?.(`arm${side}`);
      const hand = creature.findSegmentByName?.(`hand${side}`);
      const sj = creature.joints.get(`shoulder${side}`);
      const wj = creature.joints.get(`wrist${side}`);
      if (arm && hand && sj && wj) {
        this.foldSides.push({ arm, hand, sj, wj, sign: side === 'R' ? 1 : -1 });
        this.foldPose.set(arm.id, { p: new THREE.Vector3(), q: new THREE.Quaternion() });
        this.foldPose.set(hand.id, { p: new THREE.Vector3(), q: new THREE.Quaternion() });
      }
    }
    this._foldAmount = 0;

    // Tail fan: individual rectrices that pivot at the tail root and fan
    // with creature.tailSpread (written by the FlappingController)
    const tf = creature.tailFanVisual;
    if (tf) {
      const meshes = [];
      for (let i = 0; i < tf.count; i++) {
        const geo = new THREE.PlaneGeometry(tf.chord, tf.length);
        // Pivot at the near (root) end: shift geometry so origin is the root
        geo.translate(0, -tf.length / 2, 0);
        const t = tf.count > 1 ? i / (tf.count - 1) : 0.5;
        const color = new THREE.Color(tf.color).lerp(new THREE.Color(0xa89878), Math.abs(t - 0.5) * 2 * 0.5);
        const mat = new THREE.MeshPhongMaterial({
          color, emissive: color.clone().multiplyScalar(0.05),
          side: THREE.DoubleSide, transparent: true, opacity: 0.9, shininess: 14,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        this.group.add(mesh);
        meshes.push(mesh);
      }
      this.tailFan = { cfg: tf, meshes };
    }
  }

  // Build the folded wing pose for one side in world space and blend it with
  // the live physics pose by `fold` (0..1). Fold geometry: arm swept back
  // ~63° about the shoulder and pressed down ~26° against the flank; hand
  // swept to ~83° (nearly straight aft) so primaries lie along the tail region
  // without crossing the body centreline — the lateral Z-fold real gulls use.
  _computeFold(c, fold) {
    const rbT = c.root.rigidBody;
    _fT.set(rbT.orientation.x, rbT.orientation.y, rbT.orientation.z, rbT.orientation.w);
    for (const fs of this.foldSides) {
      const s = fs.sign;
      // Arm: yaw 63° aft (Ry) then roll 26° down into the flank (Rz).
      // Hand: yaw 83° aft — keeps the hand's long axis pointing toward the
      // tail (+z) with a small positive x, so it never crosses the body.
      _fA.setFromAxisAngle(_AXIS_Y, -s * 1.10);
      _fTmpQ.setFromAxisAngle(_AXIS_Z, -s * 0.45);
      _fA.premultiply(_fTmpQ);
      _fH.setFromAxisAngle(_AXIS_Y, -s * 1.45);
      _fTmpQ.setFromAxisAngle(_AXIS_Z, -s * 0.30);
      _fH.premultiply(_fTmpQ);

      // Arm center (torso frame): shoulder pivot + folded rest offset
      const pS = fs.sj.pivotA, pBa = fs.sj.pivotB;
      _fV.set(-pBa.x, -pBa.y, -pBa.z).applyQuaternion(_fA);
      const cAx = pS.x + _fV.x, cAy = pS.y + _fV.y, cAz = pS.z + _fV.z;
      // Wrist (torso frame), then hand center
      const pWa = fs.wj.pivotA, pBh = fs.wj.pivotB;
      _fV.set(pWa.x, pWa.y, pWa.z).applyQuaternion(_fA);
      const wx = cAx + _fV.x, wy = cAy + _fV.y, wz = cAz + _fV.z;
      _fV.set(-pBh.x, -pBh.y, -pBh.z).applyQuaternion(_fH);
      const cHx = wx + _fV.x, cHy = wy + _fV.y, cHz = wz + _fV.z;

      // To world, then blend with the physics pose
      const armPose = this.foldPose.get(fs.arm.id);
      const handPose = this.foldPose.get(fs.hand.id);
      const rbA = fs.arm.rigidBody, rbH = fs.hand.rigidBody;

      _fV.set(cAx, cAy, cAz).applyQuaternion(_fT)
        .add(_fV2.set(rbT.position.x, rbT.position.y, rbT.position.z));
      armPose.p.set(rbA.position.x, rbA.position.y, rbA.position.z).lerp(_fV, fold);
      _fTmpQ.copy(_fT).multiply(_fA);
      armPose.q.set(rbA.orientation.x, rbA.orientation.y, rbA.orientation.z, rbA.orientation.w)
        .slerp(_fTmpQ, fold);

      _fV.set(cHx, cHy, cHz).applyQuaternion(_fT)
        .add(_fV2.set(rbT.position.x, rbT.position.y, rbT.position.z));
      handPose.p.set(rbH.position.x, rbH.position.y, rbH.position.z).lerp(_fV, fold);
      _fTmpQ.copy(_fT).multiply(_fH);
      handPose.q.set(rbH.orientation.x, rbH.orientation.y, rbH.orientation.z, rbH.orientation.w)
        .slerp(_fTmpQ, fold);
    }
  }

  update(_lerpAlpha) {
    const c = this.creature;
    if (!c) return;

    // Wing fold pose (driven by the physical tuck signal)
    const tuck = c.flappingController ? Math.max(0, Math.min(1, c.flappingController.tuck)) : 0;
    const foldActive = tuck > 0.02 && this.foldSides.length > 0 && c.root;
    this._foldAmount = foldActive ? tuck : 0;
    if (foldActive) this._computeFold(c, tuck);
    const foldPose = foldActive ? this.foldPose : null;

    // Segments
    for (const [id, mesh] of this.segMeshes) {
      const seg = c.segments.get(id);
      if (!seg) continue;
      const fp = foldPose?.get(id);
      if (fp) {
        mesh.position.copy(fp.p);
        mesh.quaternion.copy(fp.q);
        continue;
      }
      const rb = seg.rigidBody;
      mesh.position.set(rb.position.x, rb.position.y, rb.position.z);
      mesh.quaternion.set(rb.orientation.x, rb.orientation.y, rb.orientation.z, rb.orientation.w);
    }

    // Membrane wings: copy the world-space cloth positions into the vertex
    // buffer and rebuild normals so the billow shades as it deforms.
    for (const { mem, geo, posAttr } of this.membraneEntries) {
      const src = mem.cloth.pos;       // Float64Array, world space
      const dst = posAttr.array;       // Float32Array
      for (let i = 0; i < dst.length; i++) dst[i] = src[i];
      posAttr.needsUpdate = true;
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
    }

    // Wing strips: world_pos = body_pos + R_body * bodyPoint
    //              world_rot = R_body * pitch_about_span * local_strip_rot
    // Pitch = camber + active twist command, so pronation/supination through
    // the flap cycle is visible on the wing surface.
    for (const { strip, segId, mesh } of this.stripEntries) {
      const seg = c.segments.get(segId);
      if (!seg) continue;
      const rb = seg.rigidBody;
      const fp = foldPose?.get(segId);
      const ori = fp ? fp.q : rb.orientation;
      const pos = fp ? fp.p : rb.position;
      const bp = strip.bodyPoint;
      const wp = rotByQuat(ori, bp.x, bp.y, bp.z);
      mesh.position.set(pos.x + wp.x, pos.y + wp.y, pos.z + wp.z);
      _bodyQ.set(ori.x, ori.y, ori.z, ori.w);
      const pitch = strip.camberAngle + strip.pitchOffset;
      const sd = strip.spanDir;
      _p.set(sd.x, sd.y, sd.z);
      _localQ.setFromAxisAngle(_p, pitch);
      mesh.quaternion.copy(_bodyQ).multiply(_localQ).multiply(mesh.userData.localQ);
    }

    // Feathers: same as strips, pitch = passive rachis twist + active command
    for (const { feather, segId, mesh } of this.featherEntries) {
      const seg = c.segments.get(segId);
      if (!seg) continue;
      const rb = seg.rigidBody;
      const fp = foldPose?.get(segId);
      const ori = fp ? fp.q : rb.orientation;
      const pos = fp ? fp.p : rb.position;
      const s = feather.surface;
      const bp = s.bodyPoint;
      const wp = rotByQuat(ori, bp.x, bp.y, bp.z);
      mesh.position.set(pos.x + wp.x, pos.y + wp.y, pos.z + wp.z);

      const sd = s.spanDir;
      _p.set(sd.x, sd.y, sd.z);
      _localQ.setFromAxisAngle(_p, s.pitchOffset);
      _bodyQ.set(ori.x, ori.y, ori.z, ori.w);
      mesh.quaternion.copy(_bodyQ).multiply(_localQ).multiply(mesh.userData.localQ);
    }

    // Visual attachments: rigid offsets from a parent segment (no physics body)
    for (const { att, mesh } of this.attachEntries) {
      const seg = c.segments.get(att.parentSegId);
      if (!seg) continue;
      const rb = seg.rigidBody;
      const lp = att.localPos;
      let ly = lp.y;
      // Legs stretch downward as the ground controller extends them
      if (att.leg) {
        const ext = c.legExtend ?? 0;
        mesh.scale.y = 1 + 1.8 * ext;
        ly -= 0.032 * ext;
      }
      const wp = rotByQuat(rb.orientation, lp.x, ly, lp.z);
      mesh.position.set(rb.position.x + wp.x, rb.position.y + wp.y, rb.position.z + wp.z);
      mesh.quaternion.set(rb.orientation.x, rb.orientation.y, rb.orientation.z, rb.orientation.w);
    }

    // Covert rows: static quads on their parent segment with built-in pitch
    for (const { vf, mesh } of this.coverts) {
      const seg = c.segments.get(vf.segId);
      if (!seg) continue;
      const rb = seg.rigidBody;
      const fp = foldPose?.get(vf.segId);
      const ori = fp ? fp.q : rb.orientation;
      const pos = fp ? fp.p : rb.position;
      const lp = vf.localPos;
      const wp = rotByQuat(ori, lp.x, lp.y, lp.z);
      mesh.position.set(pos.x + wp.x, pos.y + wp.y, pos.z + wp.z);
      _bodyQ.set(ori.x, ori.y, ori.z, ori.w);
      mesh.quaternion.copy(_bodyQ);
      if (vf.yaw) {
        _p.set(0, 1, 0);
        _q.setFromAxisAngle(_p, vf.yaw);
        mesh.quaternion.multiply(_q);
      }
      _p.set(1, 0, 0);
      _localQ.setFromAxisAngle(_p, vf.pitch || 0);
      mesh.quaternion.multiply(_localQ).multiply(mesh.userData.localQ);
    }

    // Tail fan: rectrices pivot at the tail root, fanning with tailSpread
    if (this.tailFan) {
      const { cfg, meshes } = this.tailFan;
      const seg = c.segments.get(cfg.segId);
      if (seg) {
        const rb = seg.rigidBody;
        const spread = c.tailSpread ?? 0;
        const fan = cfg.minFan + (cfg.maxFan - cfg.minFan) * spread;
        const root = cfg.root;
        const wp = rotByQuat(rb.orientation, root.x, root.y, root.z);
        _bodyQ.set(rb.orientation.x, rb.orientation.y, rb.orientation.z, rb.orientation.w);
        for (let i = 0; i < meshes.length; i++) {
          const t = meshes.length > 1 ? i / (meshes.length - 1) : 0.5;
          const yaw = (t - 0.5) * fan;
          const mesh = meshes[i];
          mesh.position.set(rb.position.x + wp.x, rb.position.y + wp.y, rb.position.z + wp.z);
          // R_body · R_y(yaw) · R_x(-90°): quad's length axis lies aft, fanned
          _p.set(0, 1, 0);
          _localQ.setFromAxisAngle(_p, yaw);
          mesh.quaternion.copy(_bodyQ).multiply(_localQ);
          _p.set(1, 0, 0);
          _localQ.setFromAxisAngle(_p, -Math.PI / 2);
          mesh.quaternion.multiply(_localQ);
        }
      }
    }
  }
}
