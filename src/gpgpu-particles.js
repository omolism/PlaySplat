// ---------------------------------------------------------------------------
// GPGPUParticles — multipass particle system (Phase 2 of the velocity-field
// programme). State lives in float RTs (pos + vel ping-pong), updated each
// frame via fragment passes, rendered as additive point sprites via a
// vertex shader that reads each particle's position from the pos texture.
//
// Reference: cornusammonis "Tons of Spatial-Sorted Particles" (2017) — the
// "spatial sort" is handled implicitly by additive blending (order doesn't
// matter), which scales to tens of thousands of particles without a
// per-frame depth sort.
//
// Hookup:
//   - Reads Phase-1 VelocityField texture each frame; particles drift along
//     the field's 2D velocity (projected from world to screen UV).
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

// ----- GPGPU update shaders -------------------------------------------------

const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Seed pass: stamps random positions + zero velocity into the RTs once at
// construction. uv-driven hashes are deterministic so re-running is stable.
const SEED_FRAG = /* glsl */`
  uniform vec3  uMin;
  uniform vec3  uMax;
  uniform float uMaxAge;
  uniform int   uChannel;          // 0 = pos seed, 1 = vel seed (zero)
  varying vec2 vUv;
  float h(vec2 p, float s) {
    return fract(sin(dot(p, vec2(12.9898, 78.233)) + s) * 43758.5453);
  }
  void main() {
    if (uChannel == 1) {
      gl_FragColor = vec4(0.0);    // zero initial velocity
      return;
    }
    float x = mix(uMin.x, uMax.x, h(vUv, 1.7));
    float y = mix(uMin.y, uMax.y, h(vUv, 5.3));
    float z = mix(uMin.z, uMax.z, h(vUv, 9.1));
    // Staggered initial age so particles don't all respawn in lockstep.
    float age = h(vUv, 17.7) * uMaxAge;
    gl_FragColor = vec4(x, y, z, age);
  }
`;

// Velocity update: sample the velocity field at the particle's screen-UV,
// blend into the particle's velocity, apply gravity + damping.
const VEL_FRAG = /* glsl */`
  uniform sampler2D tPos;
  uniform sampler2D tVel;
  uniform sampler2D tField;
  uniform mat4      uProjView;
  uniform float     uDt;
  uniform float     uFieldStrength;
  uniform float     uDamping;
  uniform vec3      uGravity;
  varying vec2      vUv;

  void main() {
    vec4 pos = texture2D(tPos, vUv);
    vec4 vel = texture2D(tVel, vUv);

    // Project particle world pos to clip space → NDC → field UV.
    vec4 clip = uProjView * vec4(pos.xyz, 1.0);
    if (clip.w > 0.0) {
      vec2 ndc = clip.xy / clip.w;
      vec2 fUv = ndc * 0.5 + 0.5;
      if (fUv.x >= 0.0 && fUv.x <= 1.0 && fUv.y >= 0.0 && fUv.y <= 1.0) {
        vec4 field = texture2D(tField, fUv);
        // Field is 2D; lift into 3D along camera XY.
        vec3 push = vec3(field.r, field.g, 0.0) * uFieldStrength;
        vel.xyz += push * uDt;
      }
    }

    vel.xyz += uGravity * uDt;
    // Damping per second → per-frame factor.
    vel.xyz *= pow(uDamping, max(uDt, 0.0) * 60.0);

    gl_FragColor = vel;
  }
`;

// Position update: integrate pos += vel*dt, age, respawn on age or OOB.
const POS_FRAG = /* glsl */`
  uniform sampler2D tPos;
  uniform sampler2D tVel;
  uniform float     uDt;
  uniform float     uMaxAge;
  uniform vec3      uMin;
  uniform vec3      uMax;
  varying vec2      vUv;
  float h(vec2 p, float s) {
    return fract(sin(dot(p, vec2(12.9898, 78.233)) + s) * 43758.5453);
  }
  void main() {
    vec4 pos = texture2D(tPos, vUv);
    vec4 vel = texture2D(tVel, vUv);
    pos.xyz += vel.xyz * uDt;
    pos.w  += uDt;
    // Out-of-bounds OR aged-out → respawn at random position, zero age.
    bool oob = any(lessThan(pos.xyz, uMin)) || any(greaterThan(pos.xyz, uMax));
    if (oob || pos.w > uMaxAge) {
      // Seed jitter combines uv with the OLD age so consecutive respawns
      // for the same particle don't land in the same slot.
      float s = pos.w * 13.37 + 1.0;
      pos.x = mix(uMin.x, uMax.x, h(vUv, s));
      pos.y = mix(uMin.y, uMax.y, h(vUv, s + 3.7));
      pos.z = mix(uMin.z, uMax.z, h(vUv, s + 7.1));
      pos.w = 0.0;
    }
    gl_FragColor = pos;
  }
`;

// ----- Render shaders -------------------------------------------------------

const RENDER_VERT = /* glsl */`
  uniform sampler2D tPos;
  uniform sampler2D tVel;
  uniform float     uPointSize;
  attribute vec2    reference;       // particle's coord in the pos texture
  varying float     vAgeNorm;
  varying float     vSpeed;
  void main() {
    vec4 pos = texture2D(tPos, reference);
    vec4 vel = texture2D(tVel, reference);
    vAgeNorm = clamp(pos.w / 4.0, 0.0, 1.0);    // 4 s reference max age
    vSpeed   = length(vel.xyz);
    vec4 mv = modelViewMatrix * vec4(pos.xyz, 1.0);
    gl_Position = projectionMatrix * mv;
    // Distance-attenuated point size.
    float dist = max(-mv.z, 0.1);
    gl_PointSize = uPointSize * (1.0 / dist);
  }
`;

const RENDER_FRAG = /* glsl */`
  uniform vec3  uColorCool;
  uniform vec3  uColorHot;
  uniform float uAlphaMul;
  varying float vAgeNorm;
  varying float vSpeed;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float alpha = smoothstep(0.25, 0.0, r2);
    vec3 col = mix(uColorCool, uColorHot, clamp(vSpeed * 0.18, 0.0, 1.0));
    // Fade in at birth, hold, fade out at end-of-life.
    float lifeFade = smoothstep(0.0, 0.15, vAgeNorm) *
                     (1.0 - smoothstep(0.85, 1.0, vAgeNorm));
    gl_FragColor = vec4(col * lifeFade, alpha * lifeFade * uAlphaMul);
  }
`;

// ---------------------------------------------------------------------------

export class GPGPUParticles {
  constructor(renderer, {
    size  = 64,                                                   // 64² = 4096 particles
    bounds = { min: [-5, -2, -5], max: [5, 5, 5] },
    maxAge = 4.0,
  } = {}) {
    this.renderer = renderer;
    this.size     = size;
    this.N        = size * size;
    this.maxAge   = maxAge;
    this.bounds   = bounds;

    const rtOpts = {
      type:           THREE.HalfFloatType,
      format:         THREE.RGBAFormat,
      minFilter:      THREE.NearestFilter,     // GPGPU needs NEAREST
      magFilter:      THREE.NearestFilter,
      wrapS:          THREE.ClampToEdgeWrapping,
      wrapT:          THREE.ClampToEdgeWrapping,
      depthBuffer:    false,
      stencilBuffer:  false,
    };
    this.posA = new THREE.WebGLRenderTarget(size, size, rtOpts);
    this.posB = new THREE.WebGLRenderTarget(size, size, rtOpts);
    this.velA = new THREE.WebGLRenderTarget(size, size, rtOpts);
    this.velB = new THREE.WebGLRenderTarget(size, size, rtOpts);
    this.posRead = this.posA; this.posWrite = this.posB;
    this.velRead = this.velA; this.velWrite = this.velB;

    const minV = new THREE.Vector3(...bounds.min);
    const maxV = new THREE.Vector3(...bounds.max);

    // Seed material — used once to populate pos + vel.
    this.seedMat = new THREE.ShaderMaterial({
      uniforms: {
        uMin:    { value: minV },
        uMax:    { value: maxV },
        uMaxAge: { value: maxAge },
        uChannel:{ value: 0 },
      },
      vertexShader:   QUAD_VERT,
      fragmentShader: SEED_FRAG,
    });
    this.velMat = new THREE.ShaderMaterial({
      uniforms: {
        tPos:           { value: null },
        tVel:           { value: null },
        tField:         { value: null },
        uProjView:      { value: new THREE.Matrix4() },
        uDt:            { value: 1 / 60 },
        uFieldStrength: { value: 3.0 },
        uDamping:       { value: 0.94 },
        uGravity:       { value: new THREE.Vector3(0, -0.4, 0) },
      },
      vertexShader:   QUAD_VERT,
      fragmentShader: VEL_FRAG,
    });
    this.posMat = new THREE.ShaderMaterial({
      uniforms: {
        tPos:    { value: null },
        tVel:    { value: null },
        uDt:     { value: 1 / 60 },
        uMaxAge: { value: maxAge },
        uMin:    { value: minV },
        uMax:    { value: maxV },
      },
      vertexShader:   QUAD_VERT,
      fragmentShader: POS_FRAG,
    });

    // Copy material — used by seedFromPositions() to blit a CPU-side
    // DataTexture (containing voxel positions) into the pos RTs.
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader:   QUAD_VERT,
      fragmentShader: /* glsl */`
        uniform sampler2D tSrc;
        varying vec2 vUv;
        void main() { gl_FragColor = texture2D(tSrc, vUv); }
      `,
    });

    this.seedQuad = new FullScreenQuad(this.seedMat);
    this.velQuad  = new FullScreenQuad(this.velMat);
    this.posQuad  = new FullScreenQuad(this.posMat);
    this.copyQuad = new FullScreenQuad(this.copyMat);

    // ---- Seed both pos RTs (so the read RT has data immediately) and
    // ---- the vel RTs to zero.
    this._seed();

    // ---- Render mesh ----------------------------------------------------
    // Geometry has N vertices; each carries a `reference` attribute = its
    // texture-space coord. The vertex shader looks up the live pos from
    // the pos RT to set gl_Position.
    const geo = new THREE.BufferGeometry();
    const positions  = new Float32Array(this.N * 3);    // dummy
    const references = new Float32Array(this.N * 2);
    const sz = size;
    for (let i = 0; i < this.N; i++) {
      const u = ((i % sz) + 0.5) / sz;
      const v = (Math.floor(i / sz) + 0.5) / sz;
      references[i * 2]     = u;
      references[i * 2 + 1] = v;
    }
    geo.setAttribute("position",  new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("reference", new THREE.BufferAttribute(references, 2));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);

    this.renderMat = new THREE.ShaderMaterial({
      uniforms: {
        tPos:       { value: this.posRead.texture },
        tVel:       { value: this.velRead.texture },
        uPointSize: { value: 16.0 },
        uColorCool: { value: new THREE.Color(0.30, 0.75, 1.00) },
        uColorHot:  { value: new THREE.Color(1.00, 0.55, 0.20) },
        uAlphaMul:  { value: 1.0 },
      },
      vertexShader:   RENDER_VERT,
      fragmentShader: RENDER_FRAG,
      transparent:    true,
      depthWrite:     false,
      blending:       THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.renderMat);
    this.points.frustumCulled = false;
    this.points.visible = false;        // default off; GUI toggle enables
  }

  _seed() {
    const prev = this.renderer.getRenderTarget();
    // Pos seed
    this.seedMat.uniforms.uChannel.value = 0;
    this.renderer.setRenderTarget(this.posA); this.seedQuad.render(this.renderer);
    this.renderer.setRenderTarget(this.posB); this.seedQuad.render(this.renderer);
    // Vel seed (zero)
    this.seedMat.uniforms.uChannel.value = 1;
    this.renderer.setRenderTarget(this.velA); this.seedQuad.render(this.renderer);
    this.renderer.setRenderTarget(this.velB); this.seedQuad.render(this.renderer);
    this.renderer.setRenderTarget(prev);
  }

  /**
   * One simulation step. Call once per frame.
   * @param {number} dt  Frame delta in seconds.
   * @param {THREE.Camera} camera For pos→screen-UV projection.
   * @param {THREE.Texture|null} fieldTex Velocity-field texture (from
   *   VelocityField.getTexture()). Pass null to skip the field push.
   */
  step(dt, camera, fieldTex) {
    if (!this.points.visible) return;       // skip work when disabled
    const prevTarget = this.renderer.getRenderTarget();

    // -- Velocity pass --
    this.velMat.uniforms.tPos.value  = this.posRead.texture;
    this.velMat.uniforms.tVel.value  = this.velRead.texture;
    this.velMat.uniforms.tField.value = fieldTex;
    this.velMat.uniforms.uDt.value   = Math.min(dt, 0.05);
    this.velMat.uniforms.uProjView.value
        .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.renderer.setRenderTarget(this.velWrite);
    this.velQuad.render(this.renderer);
    // swap
    const vt = this.velRead; this.velRead = this.velWrite; this.velWrite = vt;

    // -- Position pass --
    this.posMat.uniforms.tPos.value = this.posRead.texture;
    this.posMat.uniforms.tVel.value = this.velRead.texture;
    this.posMat.uniforms.uDt.value  = Math.min(dt, 0.05);
    this.renderer.setRenderTarget(this.posWrite);
    this.posQuad.render(this.renderer);
    const pt = this.posRead; this.posRead = this.posWrite; this.posWrite = pt;

    this.renderer.setRenderTarget(prevTarget);

    // Update the render material's texture refs.
    this.renderMat.uniforms.tPos.value = this.posRead.texture;
    this.renderMat.uniforms.tVel.value = this.velRead.texture;
  }

  setEnabled(on) { this.points.visible = !!on; }
  setPointSize(s) { this.renderMat.uniforms.uPointSize.value = s; }
  setFieldStrength(s) { this.velMat.uniforms.uFieldStrength.value = s; }
  setDamping(d) { this.velMat.uniforms.uDamping.value = d; }
  setGravity(y) { this.velMat.uniforms.uGravity.value.y = y; }
  setAlphaMul(a) { this.renderMat.uniforms.uAlphaMul.value = a; }
  setColorCool(hex) { this.renderMat.uniforms.uColorCool.value.set(hex); }
  setColorHot(hex)  { this.renderMat.uniforms.uColorHot.value.set(hex); }

  // Resize the spawn AABB — used by seedFromPositions() so voxel-seeded
  // particles don't get instantly bounced by an OOB respawn.
  setBounds(min, max) {
    this.bounds = { min: [min.x, min.y, min.z], max: [max.x, max.y, max.z] };
    this.posMat.uniforms.uMin.value.set(min.x, min.y, min.z);
    this.posMat.uniforms.uMax.value.set(max.x, max.y, max.z);
    this.seedMat.uniforms.uMin.value.set(min.x, min.y, min.z);
    this.seedMat.uniforms.uMax.value.set(max.x, max.y, max.z);
  }

  // Replace every particle's position with a voxel center (cycled by
  // index, so all N particles get a starting slot even if voxelCount < N).
  // Ages are staggered randomly so respawn waves don't sync. Velocities
  // are zeroed so seeded particles start at rest, then accelerate via the
  // velocity field on subsequent frames.
  seedFromPositions(positions, count) {
    if (!positions || count <= 0) return false;
    const N = this.N;
    const data = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      const vi = (i % count) * 3;
      data[i * 4]     = positions[vi];
      data[i * 4 + 1] = positions[vi + 1];
      data[i * 4 + 2] = positions[vi + 2];
      data[i * 4 + 3] = Math.random() * this.maxAge;
    }
    const tex = new THREE.DataTexture(data, this.size, this.size,
                                      THREE.RGBAFormat, THREE.FloatType);
    tex.needsUpdate = true;

    const prev = this.renderer.getRenderTarget();
    this.copyMat.uniforms.tSrc.value = tex;
    // Blit into both pos RTs so the read+write swap is irrelevant; the
    // first step() then writes to whichever is currently the write target.
    this.renderer.setRenderTarget(this.posA);
    this.copyQuad.render(this.renderer);
    this.renderer.setRenderTarget(this.posB);
    this.copyQuad.render(this.renderer);
    // Zero velocities for a clean start (use the seed material at uChannel=1).
    this.seedMat.uniforms.uChannel.value = 1;
    this.renderer.setRenderTarget(this.velA);
    this.seedQuad.render(this.renderer);
    this.renderer.setRenderTarget(this.velB);
    this.seedQuad.render(this.renderer);
    this.renderer.setRenderTarget(prev);

    this.posRead = this.posA; this.posWrite = this.posB;
    this.velRead = this.velA; this.velWrite = this.velB;

    tex.dispose();
    return true;
  }

  dispose() {
    [this.posA, this.posB, this.velA, this.velB].forEach(rt => rt.dispose());
    this.seedMat.dispose();
    this.velMat.dispose();
    this.posMat.dispose();
    this.renderMat.dispose();
    this.copyMat.dispose();
    this.seedQuad.dispose();
    this.velQuad.dispose();
    this.posQuad.dispose();
    this.copyQuad.dispose();
    this.points.geometry.dispose();
  }
}
