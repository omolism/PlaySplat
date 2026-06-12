import * as THREE from "three";

// ---------------------------------------------------------------------------
// Quadizer — one camera-facing billboard quad per splat, colored by its
// underlying vertex color. Conceptually like Voxelizer (instanced prims,
// reading splat color) but with a flat plane oriented to face the camera in
// the vertex shader.
//
// Like Voxelizer, each instance also responds to the global FX state (wave /
// dissolve / scan-line) via the shared fxOffset/fxColorTint functions in
// src/fx-glsl.js — clicking the scene animates billboards and splats alike.
// ---------------------------------------------------------------------------

const QUAD_VERT = /* glsl */`
  uniform float uQuadSize;
  uniform float uOpacity;
  attribute vec3 aInstanceCenter;
  attribute vec3 aInstanceColor;
  varying vec3 vColor;
  varying vec2 vLocalUv;
  void main() {
    // Billboards are intentionally static — they don't react to the splat's
    // click FX. (To re-enable, restore fxOffset/fxColorTint here and the
    // shader-uniform sync in syncFxUniforms below — see src/fx-glsl.js.)
    vColor           = aInstanceColor;
    // PlaneGeometry's position is centered at origin with extents -0.5..0.5,
    // so position.xy doubles as a centered local UV in the [-0.5, 0.5] range
    // — exactly what the circle discard test needs.
    vLocalUv         = position.xy;
    vec4 worldCenter = modelMatrix * vec4(aInstanceCenter, 1.0);
    vec4 viewCenter  = viewMatrix  * worldCenter;
    vec3 corner      = vec3(position.x, position.y, 0.0) * uQuadSize;
    vec4 viewPos     = vec4(viewCenter.xyz + corner, 1.0);
    gl_Position      = projectionMatrix * viewPos;
  }
`;

const QUAD_FRAG = /* glsl */`
  varying vec3 vColor;
  varying vec2 vLocalUv;
  uniform float uOpacity;
  uniform float uIsCircle;     // 0 = square quad, 1 = camera-facing disc
  void main() {
    // Circle subform: discard pixels outside the unit disc (centered at 0,
    // radius 0.5). Anti-alias via smoothstep on the radial distance for a
    // soft edge that holds up at small sizes.
    if (uIsCircle > 0.5) {
      float r = length(vLocalUv);
      if (r > 0.5) discard;
      float aa = smoothstep(0.5, 0.45, r);
      gl_FragColor = vec4(vColor, uOpacity * aa);
      return;
    }
    gl_FragColor = vec4(vColor, uOpacity);
  }
`;

export class Quadizer {
  constructor({ scene, splatMesh, quadSize = 0.0015, shape = "quad", fxUniforms = null }) {
    this.scene      = scene;
    this.splatMesh  = splatMesh;
    this.quadSize   = quadSize;
    this.shape      = shape;          // "quad" | "circle"
    this.fxUniforms = fxUniforms;
    this.opacity    = 0;
    this.mesh       = null;
    this._busy      = false;
  }

  setQuadSize(s) {
    this.quadSize = s;
    if (this.mesh) this.mesh.material.uniforms.uQuadSize.value = s;
  }

  // Switch between square billboard and camera-facing disc. Cheap: a single
  // shader uniform — no geometry rebuild required.
  setShape(s) {
    this.shape = (s === "circle") ? "circle" : "quad";
    if (this.mesh) {
      this.mesh.material.uniforms.uIsCircle.value = (this.shape === "circle") ? 1.0 : 0.0;
    }
  }

  setOpacity(o) {
    this.opacity = Math.max(0, Math.min(1, o));
    if (this.mesh) {
      this.mesh.material.uniforms.uOpacity.value = this.opacity;
      this.mesh.visible = this.opacity > 0.005;
    }
  }

  // No-op — billboards are static. Kept as a stub so main.js can call this
  // unconditionally (re-wiring FX later is a one-line restore).
  syncFxUniforms() { /* intentionally empty */ }

  rebuild() {
    if (this._busy) return 0;
    this._busy = true;
    const t0 = performance.now();
    try {
      // Two-pass: count splats, then fill typed arrays
      let n = 0;
      this.splatMesh.forEachSplat(() => n++);
      if (n === 0) { this._busy = false; return 0; }

      const positions = new Float32Array(n * 3);
      const colors    = new Float32Array(n * 3);
      let i = 0;
      this.splatMesh.forEachSplat((idx, center, _s, _q, _o, color) => {
        const k = i * 3;
        positions[k    ] = center.x;
        positions[k + 1] = center.y;
        positions[k + 2] = center.z;
        colors[k    ] = color.r;
        colors[k + 1] = color.g;
        colors[k + 2] = color.b;
        i++;
      });

      if (this.mesh) {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
        this.mesh = null;
      }

      const plane = new THREE.PlaneGeometry(1, 1);
      const geom  = new THREE.InstancedBufferGeometry();
      geom.index               = plane.index;
      geom.attributes.position = plane.attributes.position;
      geom.attributes.uv       = plane.attributes.uv;
      geom.instanceCount       = n;
      geom.setAttribute("aInstanceCenter",
        new THREE.InstancedBufferAttribute(positions, 3));
      geom.setAttribute("aInstanceColor",
        new THREE.InstancedBufferAttribute(colors, 3));

      const mat = new THREE.ShaderMaterial({
        vertexShader:   QUAD_VERT,
        fragmentShader: QUAD_FRAG,
        uniforms: {
          uQuadSize: { value: this.quadSize },
          uOpacity:  { value: this.opacity },
          uIsCircle: { value: this.shape === "circle" ? 1.0 : 0.0 },
        },
        transparent: true,
        depthWrite:  true,
      });

      const mesh = new THREE.Mesh(geom, mat);
      mesh.frustumCulled = false;
      mesh.position.copy(this.splatMesh.position);
      mesh.quaternion.copy(this.splatMesh.quaternion);
      mesh.scale.copy(this.splatMesh.scale);
      mesh.renderOrder = 1;

      this.scene.add(mesh);
      this.mesh = mesh;
      this._busy = false;
      if (this.fxUniforms) this.syncFxUniforms(this.fxUniforms);
      const ms = (performance.now() - t0).toFixed(0);
      console.info(`[Quadizer] built ${n} billboards in ${ms}ms (quadSize=${this.quadSize})`);
      return n;
    } catch (e) {
      console.error("[Quadizer] build error:", e);
      this._busy = false;
      return 0;
    }
  }

  dispose() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
  }
}
