import * as THREE from "three";

// ---------------------------------------------------------------------------
// COLMAP binary file readers — minimal, only what the data-label overlay
// needs (camera per-image extrinsics + filename).
//
// Format reference: colmap/scripts/python/read_write_model.py
//
//   images.bin
//   ┌─ uint64  num_reg_images
//   │  for each image:
//   │     uint32  image_id
//   │     double  qw, qx, qy, qz        (rotation, world → camera)
//   │     double  tx, ty, tz            (translation, world → camera)
//   │     uint32  camera_id
//   │     char[]  name (null-terminated)
//   │     uint64  num_points2d
//   │     for each point2d:
//   │        double x, y
//   │        int64  point3d_id
//
// Camera position in WORLD space = -R(q)^T · t  ≡  conjugate(q) · (-t)
// ---------------------------------------------------------------------------

class BinReader {
  constructor(buffer) {
    this.dv = new DataView(buffer);
    this.byteLength = buffer.byteLength;
    this.p = 0;
  }
  u32() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  u64() { const v = this.dv.getBigUint64(this.p, true); this.p += 8; return Number(v); }
  i64() { const v = this.dv.getBigInt64(this.p, true); this.p += 8; return Number(v); }
  f64() { const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  // Skip n bytes (used to fast-forward over points-2d blocks)
  skip(n) { this.p += n; }
  // Null-terminated UTF-8 string
  str0() {
    let s = "";
    while (this.p < this.byteLength) {
      const c = this.dv.getUint8(this.p++);
      if (c === 0) return s;
      s += String.fromCharCode(c);
    }
    return s;
  }
}

/**
 * Load and parse `images.bin` (COLMAP binary format).
 *
 * @param {string} url
 * @returns {Promise<Array<{
 *   imageId: number,
 *   q: [number, number, number, number],   // qw, qx, qy, qz
 *   t: [number, number, number],
 *   cameraId: number,
 *   name: string,
 * }>>}
 */
export async function loadColmapImages(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`COLMAP: ${res.status} fetching ${url}`);
  const buf = await res.arrayBuffer();
  const r = new BinReader(buf);

  const n = r.u64();
  const out = [];
  for (let i = 0; i < n; i++) {
    const imageId  = r.u32();
    const qw       = r.f64(), qx = r.f64(), qy = r.f64(), qz = r.f64();
    const tx       = r.f64(), ty = r.f64(), tz = r.f64();
    const cameraId = r.u32();
    const name     = r.str0();
    const np2d     = r.u64();
    r.skip(np2d * (8 + 8 + 8));   // 2×double + 1×int64 per 2D point
    out.push({ imageId, q: [qw, qx, qy, qz], t: [tx, ty, tz], cameraId, name });
  }
  return out;
}

/**
 * Convert a COLMAP image record to the camera's world-space position.
 *
 * World→camera transform is x_cam = R(q) · x_world + t.
 * Camera center in world = -R(q)^T · t = conjugate(q) · (-t).
 *
 * @param {{q:[number,number,number,number], t:[number,number,number]}} image
 * @returns {THREE.Vector3} world-space camera position
 */
export function colmapCameraPosition(image) {
  const [qw, qx, qy, qz] = image.q;
  const [tx, ty, tz]     = image.t;
  // THREE.Quaternion is (x, y, z, w)
  const qConj = new THREE.Quaternion(-qx, -qy, -qz, qw);     // q⁻¹  for unit q
  return new THREE.Vector3(-tx, -ty, -tz).applyQuaternion(qConj);
}

/**
 * Camera→world rotation for a COLMAP image record (the conjugate of stored q).
 *
 * @param {{q:[number,number,number,number]}} image
 * @returns {THREE.Quaternion}
 */
export function colmapCameraRotation(image) {
  const [qw, qx, qy, qz] = image.q;
  return new THREE.Quaternion(-qx, -qy, -qz, qw);            // q⁻¹  for unit q
}

/**
 * Build one merged LineSegments mesh holding a wireframe pyramid frustum for
 * every COLMAP camera (Postshot-style capture marker).
 *
 *   apex = camera center
 *   base = 4 corners at +Z (COLMAP camera looks down +Z in camera space)
 *
 * The optional `flipX180` flag mirrors the same 180°-around-X correction the
 * splat mesh uses (Postshot/Inria Y-down → Three.js Y-up).
 *
 * @param {Array} images        — output of loadColmapImages()
 * @param {object} opts
 * @param {number} opts.size    — half-width of the pyramid base (world units)
 * @param {number} opts.aspect  — base width / height
 * @param {number} opts.depth   — distance from apex to base (world units)
 * @param {boolean} opts.flipX180
 * @param {number}  opts.color
 * @param {number}  opts.opacity
 * @returns {THREE.LineSegments}
 */
export function buildColmapFrustums(images, {
  size      = 0.12,
  aspect    = 1.5,
  depth     = 0.22,
  flipX180  = true,
  color     = 0xffffff,
  opacity   = 0.85,
} = {}) {
  const w = size * aspect;
  const h = size;
  const d = depth;
  const apex = new THREE.Vector3(0, 0, 0);
  const c0 = new THREE.Vector3(-w, -h, d);
  const c1 = new THREE.Vector3( w, -h, d);
  const c2 = new THREE.Vector3( w,  h, d);
  const c3 = new THREE.Vector3(-w,  h, d);
  const edges = [
    [apex, c0], [apex, c1], [apex, c2], [apex, c3],   // apex → corners
    [c0, c1], [c1, c2], [c2, c3], [c3, c0],           // base loop
  ];

  const flip = flipX180 ? new THREE.Quaternion(1, 0, 0, 0) : null;  // 180° around X
  const positions = new Float32Array(images.length * edges.length * 2 * 3);
  const tmp = new THREE.Vector3();
  let off = 0;
  // Parallel metadata array — same index space as `images`, used by the
  // hover-pick code to identify which frustum the cursor is over.
  const frustums = [];

  for (const im of images) {
    const pos = colmapCameraPosition(im);
    const rot = colmapCameraRotation(im);
    if (flip) {
      pos.y = -pos.y; pos.z = -pos.z;
      rot.premultiply(flip);
    }
    for (const [a, b] of edges) {
      tmp.copy(a).applyQuaternion(rot).add(pos);
      positions[off++] = tmp.x; positions[off++] = tmp.y; positions[off++] = tmp.z;
      tmp.copy(b).applyQuaternion(rot).add(pos);
      positions[off++] = tmp.x; positions[off++] = tmp.y; positions[off++] = tmp.z;
    }
    frustums.push({
      pos:      pos.clone(),
      // Final camera→world rotation in Three.js conventions (after flipX180).
      rot:      rot.clone(),
      // Raw COLMAP fields exposed for technical inspection.
      name:     im.name,
      imageId:  im.imageId,
      cameraId: im.cameraId,
      qRaw:     im.q.slice(),                            // [qw, qx, qy, qz]
      tRaw:     im.t.slice(),                            // [tx, ty, tz]
    });
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  // Always-on-top overlay: skip depth test/write and force last in draw order
  // so the frustums stay visible behind Quad / Voxel layers too.
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest:  false,
    depthWrite: false,
  });
  const mesh = new THREE.LineSegments(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder   = 999;
  mesh.userData.frustums    = frustums;
  mesh.userData.pickRadius  = size * 2.5;   // hover hit radius in world units
  return mesh;
}
