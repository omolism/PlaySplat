import * as THREE from "three";

// ---------------------------------------------------------------------------
// Voxelizer — USD-PointInstancer-style cube voxelisation of a SplatMesh.
//
// Splats are bucketed into a uniform grid; for each occupied cell we keep an
// average position, color, and opacity. The result is rendered as a Mesh
// driven by an InstancedBufferGeometry of unit cubes scaled by voxelSize.
//
// Each cube responds to the global FX state (wave / dissolve / scan-line) via
// the shared fxOffset/fxColorTint functions in src/fx-glsl.js — i.e. clicking
// the scene displaces and tints voxels the same way it displaces splats.
//
// Reference (OpenUSD PointInstancer): N transforms + a single prototype prim.
//
// Rebuild cost: O(N_splats) JS pass + O(cells) GPU upload. The 2.6M splat
// scene takes ~2-3 s, so rebuild is debounced 300 ms after the slider stops.
// ---------------------------------------------------------------------------

const REBUILD_DEBOUNCE_MS = 300;

const VOXEL_VERT = /* glsl */`
  uniform float uVoxelSize;
  uniform float uOpacity;
  attribute vec3 aInstanceCenter;
  attribute vec3 aInstanceColor;
  varying vec3 vColor;
  void main() {
    // Voxel cubes are intentionally static — they don't react to the splat's
    // click FX. (To re-enable, restore fxOffset/fxColorTint here and the
    // shader-uniform sync in syncFxUniforms below — see src/fx-glsl.js.)
    vec3 worldPos = aInstanceCenter + position * (uVoxelSize * 0.96);
    vColor       = aInstanceColor;
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
  }
`;

const VOXEL_FRAG = /* glsl */`
  varying vec3 vColor;
  uniform float uOpacity;
  void main() {
    gl_FragColor = vec4(vColor, uOpacity);
  }
`;

export class Voxelizer {
  constructor({ scene, splatMesh, voxelSize = 0.013, shape = "cube", fxUniforms = null }) {
    this.scene      = scene;
    this.splatMesh  = splatMesh;
    this.voxelSize  = voxelSize;
    this.shape      = shape;          // "cube" | "sphere"
    this.fxUniforms = fxUniforms;     // optional; see syncFxUniforms()
    this.mesh       = null;
    this.opacity    = 0;
    this._dirty     = true;
    this._busy      = false;
    this._rebuildTimer = null;
  }

  setVoxelSize(s) {
    if (Math.abs(s - this.voxelSize) < 1e-6) return;
    this.voxelSize = s;
    this._dirty = true;
    if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => this.rebuild(), REBUILD_DEBOUNCE_MS);
  }

  // Switch between cube and icosphere prototypes. Requires a geometry rebuild
  // (different vertex / index buffers), so this is a real rebuild — debounced
  // the same way setVoxelSize is, in case the user toggles back and forth.
  // No-op rebuild if the mesh doesn't exist yet (i.e. the layer is hidden) —
  // the next layer-show in main.js will build with the latest shape.
  setShape(s) {
    const next = (s === "sphere") ? "sphere" : "cube";
    if (next === this.shape) return;
    this.shape = next;
    this._dirty = true;
    if (!this.mesh) return;
    if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => this.rebuild(), REBUILD_DEBOUNCE_MS);
  }

  setOpacity(o) {
    this.opacity = Math.max(0, Math.min(1, o));
    if (this.mesh) {
      this.mesh.material.uniforms.uOpacity.value = this.opacity;
      this.mesh.visible = this.opacity > 0.005;
    }
  }

  // No-op — voxels are static. Kept as a stub so main.js can call this
  // unconditionally (and so re-wiring FX later is a one-line restore).
  syncFxUniforms() { /* intentionally empty */ }

  rebuild() {
    if (this._busy) return;
    this._busy = true;
    const t0 = performance.now();
    try {
      const vs    = Math.max(this.voxelSize, 0.001);
      const invVs = 1.0 / vs;

      const cells = new Map();
      this.splatMesh.forEachSplat((index, center, scales, quaternion, opacity, color) => {
        const ix = Math.floor(center.x * invVs);
        const iy = Math.floor(center.y * invVs);
        const iz = Math.floor(center.z * invVs);
        const key = `${ix},${iy},${iz}`;
        let cell = cells.get(key);
        if (!cell) {
          cell = {
            cx: (ix + 0.5) * vs,
            cy: (iy + 0.5) * vs,
            cz: (iz + 0.5) * vs,
            r: 0, g: 0, b: 0, a: 0, n: 0,
          };
          cells.set(key, cell);
        }
        cell.r += color.r;
        cell.g += color.g;
        cell.b += color.b;
        cell.a += opacity;
        cell.n += 1;
      });

      if (this.mesh) {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
        this.mesh = null;
      }

      const cellArr = Array.from(cells.values());
      if (cellArr.length === 0) { this._busy = false; return 0; }

      const n = cellArr.length;
      const positions = new Float32Array(n * 3);
      const colors    = new Float32Array(n * 3);
      let xMin = Infinity, yMin = Infinity, zMin = Infinity;
      let xMax = -Infinity, yMax = -Infinity, zMax = -Infinity;
      for (let i = 0; i < n; i++) {
        const c = cellArr[i];
        const k = i * 3;
        positions[k]   = c.cx;
        positions[k+1] = c.cy;
        positions[k+2] = c.cz;
        if (c.cx < xMin) xMin = c.cx; if (c.cx > xMax) xMax = c.cx;
        if (c.cy < yMin) yMin = c.cy; if (c.cy > yMax) yMax = c.cy;
        if (c.cz < zMin) zMin = c.cz; if (c.cz > zMax) zMax = c.cz;
        const inv = 1.0 / Math.max(c.n, 1);
        colors[k]   = c.r * inv;
        colors[k+1] = c.g * inv;
        colors[k+2] = c.b * inv;
      }

      // Cached for Phase-3 hook: GPGPUParticles can seed from these.
      this.cellPositions = positions;
      this.cellCount     = n;
      this.cellBoundsMin = new THREE.Vector3(xMin, yMin, zMin);
      this.cellBoundsMax = new THREE.Vector3(xMax, yMax, zMax);

      // Proto geometry — Cube (BoxGeometry) or Sphere (IcosahedronGeometry
      // at detail=1 → 80 tris per instance, smooth enough at typical voxel
      // sizes without blowing the tri budget at ~10-50k cells).
      const proto = this.shape === "sphere"
        ? new THREE.IcosahedronGeometry(0.5, 1)
        : new THREE.BoxGeometry(1, 1, 1);
      const geom = new THREE.InstancedBufferGeometry();
      geom.index               = proto.index;
      geom.attributes.position = proto.attributes.position;
      if (proto.attributes.uv)     geom.attributes.uv     = proto.attributes.uv;
      if (proto.attributes.normal) geom.attributes.normal = proto.attributes.normal;
      geom.instanceCount       = n;
      geom.setAttribute("aInstanceCenter",
        new THREE.InstancedBufferAttribute(positions, 3));
      geom.setAttribute("aInstanceColor",
        new THREE.InstancedBufferAttribute(colors, 3));

      const mat = new THREE.ShaderMaterial({
        vertexShader:   VOXEL_VERT,
        fragmentShader: VOXEL_FRAG,
        uniforms: {
          uVoxelSize: { value: vs },
          uOpacity:   { value: this.opacity },
        },
        transparent: true,
        depthWrite:  true,
      });

      const mesh = new THREE.Mesh(geom, mat);
      mesh.frustumCulled = false;       // FX offsets push past world bounds
      mesh.position.copy(this.splatMesh.position);
      mesh.quaternion.copy(this.splatMesh.quaternion);
      mesh.scale.copy(this.splatMesh.scale);
      mesh.renderOrder = 1;

      this.scene.add(mesh);
      this.mesh = mesh;
      this._dirty = false;
      this._busy = false;
      // Sync once immediately so the first frame after build looks right.
      if (this.fxUniforms) this.syncFxUniforms(this.fxUniforms);
      const ms = (performance.now() - t0).toFixed(0);
      console.info(`[Voxelizer] built ${n} ${this.shape}s from splats in ${ms}ms (voxelSize=${vs})`);
      return n;
    } catch (e) {
      console.error("[Voxelizer] build error:", e);
      this._busy = false;
      return 0;
    }
  }

  dispose() {
    if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
  }
}
