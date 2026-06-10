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
  return new THREE.Mesh(geo, mat);
}

function makeStripMesh(strip) {
  const geo = new THREE.PlaneGeometry(strip.chord, strip.span);
  const mat = new THREE.MeshPhongMaterial({
    color: 0xc8b89a, emissive: 0x100d06,
    side: THREE.DoubleSide, transparent: true, opacity: 0.60, shininess: 50,
  });
  const mesh = new THREE.Mesh(geo, mat);
  // Store the local-frame quaternion (body-local, before body rotation)
  mesh.userData.localQ = quatFromFrame(strip.chordDir, strip.spanDir);
  return mesh;
}

function makeFeatherMesh(feather) {
  const s = feather.surface;
  const geo = new THREE.PlaneGeometry(s.chord, s.span);
  const mat = new THREE.MeshPhongMaterial({
    color: 0xddd0b0, emissive: 0x0c0a04,
    side: THREE.DoubleSide, transparent: true, opacity: 0.82, shininess: 15,
  });
  return new THREE.Mesh(geo, mat);
}

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
    this.creature = creature;

    for (const [id, seg] of creature.segments) {
      const mesh = makeSegmentMesh(seg);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.segMeshes.set(id, mesh);
    }

    for (const wing of creature.wings.values()) {
      for (const strip of wing.strips) {
        const mesh = makeStripMesh(strip);
        mesh.frustumCulled = false;
        this.group.add(mesh);
        this.stripEntries.push({ strip, segId: wing.segmentId, mesh });
      }
    }

    for (const fa of creature.featherArrays.values()) {
      for (const feather of fa.feathers) {
        const mesh = makeFeatherMesh(feather);
        mesh.frustumCulled = false;
        this.group.add(mesh);
        this.featherEntries.push({ feather, segId: fa.segmentId, mesh });
      }
    }
  }

  update(_lerpAlpha) {
    const c = this.creature;
    if (!c) return;

    // Segments
    for (const [id, mesh] of this.segMeshes) {
      const seg = c.segments.get(id);
      if (!seg) continue;
      const rb = seg.rigidBody;
      mesh.position.set(rb.position.x, rb.position.y, rb.position.z);
      mesh.quaternion.set(rb.orientation.x, rb.orientation.y, rb.orientation.z, rb.orientation.w);
    }

    // Wing strips: world_pos = body_pos + R_body * bodyPoint
    //              world_rot = R_body * local_strip_rot
    for (const { strip, segId, mesh } of this.stripEntries) {
      const seg = c.segments.get(segId);
      if (!seg) continue;
      const rb = seg.rigidBody;
      const bp = strip.bodyPoint;
      const wp = rotByQuat(rb.orientation, bp.x, bp.y, bp.z);
      mesh.position.set(rb.position.x + wp.x, rb.position.y + wp.y, rb.position.z + wp.z);
      _bodyQ.set(rb.orientation.x, rb.orientation.y, rb.orientation.z, rb.orientation.w);
      mesh.quaternion.copy(_bodyQ).multiply(mesh.userData.localQ);
    }

    // Feathers: same as strips but with passive pitch applied
    for (const { feather, segId, mesh } of this.featherEntries) {
      const seg = c.segments.get(segId);
      if (!seg) continue;
      const rb = seg.rigidBody;
      const s = feather.surface;
      const bp = s.bodyPoint;
      const wp = rotByQuat(rb.orientation, bp.x, bp.y, bp.z);
      mesh.position.set(rb.position.x + wp.x, rb.position.y + wp.y, rb.position.z + wp.z);

      // Apply passive pitch rotation about spanDir
      const pitch = feather.pitch ?? 0;
      const sd = s.spanDir;
      const axisQ = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(sd.x, sd.y, sd.z), pitch);
      const baseQ = quatFromFrame(s.chordDir, s.spanDir);
      _bodyQ.set(rb.orientation.x, rb.orientation.y, rb.orientation.z, rb.orientation.w);
      mesh.quaternion.copy(_bodyQ).multiply(axisQ).multiply(baseQ);
    }
  }
}
