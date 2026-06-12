// ---------------------------------------------------------------------------
// VelocityField — 2D ping-pong fluid field
// Inspired by lomateron's "velocity conservation" Shadertoy (2021): a
// convolution-driven velocity grid where momentum never zeros out. Each
// frame:
//   1. Diffuse: a 3x3 box-blur of the velocity (mild smoothing).
//   2. Advect:  semi-Lagrangian step — sample the field one velocity-step
//               back in time, mix with the diffused value.
//   3. Decay:   tiny multiplicative falloff so the field eventually settles
//               if no new mass is injected (otherwise floating-point drift
//               accumulates forever). Mass channel decays faster than
//               velocity so impulses fade but their flow persists.
// Other modules call inject(uv, vel, mass) on interaction (hand pinch /
// mouse press) — the field stamps an exponential bump of velocity and mass
// at the input UV. Render passes that want to react to the field sample
// getTexture() in their fragment shader (RG = velocity, B = mass, A = 0).
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

const UPDATE_FRAG = /* glsl */`
  uniform sampler2D tPrev;
  uniform vec2  uTexel;
  uniform float uVelDecay;
  uniform float uMassDecay;
  uniform float uAdvectStrength;
  varying vec2 vUv;

  void main() {
    // 3x3 weighted sample for diffusion. Centre-heavy weights so detail
    // isn't washed out — equal weights would blur the field too fast.
    vec4 sum = vec4(0.0);
    sum += texture2D(tPrev, vUv + vec2(-1.0, -1.0) * uTexel) * 0.05;
    sum += texture2D(tPrev, vUv + vec2( 0.0, -1.0) * uTexel) * 0.10;
    sum += texture2D(tPrev, vUv + vec2( 1.0, -1.0) * uTexel) * 0.05;
    sum += texture2D(tPrev, vUv + vec2(-1.0,  0.0) * uTexel) * 0.10;
    sum += texture2D(tPrev, vUv + vec2( 0.0,  0.0) * uTexel) * 0.40;
    sum += texture2D(tPrev, vUv + vec2( 1.0,  0.0) * uTexel) * 0.10;
    sum += texture2D(tPrev, vUv + vec2(-1.0,  1.0) * uTexel) * 0.05;
    sum += texture2D(tPrev, vUv + vec2( 0.0,  1.0) * uTexel) * 0.10;
    sum += texture2D(tPrev, vUv + vec2( 1.0,  1.0) * uTexel) * 0.05;

    // Semi-Lagrangian advection: trace backwards along the velocity, sample
    // what WAS at that position, mix with the diffused value. This is what
    // makes the field carry impulses forward over time (the "velocity never
    // dies" character from the reference).
    vec2  vel     = sum.rg;
    vec2  backUv  = vUv - vel * uTexel * uAdvectStrength;
    vec4  advect  = texture2D(tPrev, backUv);
    sum.rg = mix(sum.rg, advect.rg, 0.55);

    // Tiny global decay so floating-point drift doesn't accumulate to NaN.
    sum.r *= uVelDecay;
    sum.g *= uVelDecay;
    sum.b *= uMassDecay;
    sum.a  = 0.0;

    // Clamp velocity magnitude so a runaway feedback loop doesn't explode
    // — the reference shader's "going to move faster and faster" caveat.
    float vmag = length(sum.rg);
    if (vmag > 8.0) sum.rg *= 8.0 / vmag;

    gl_FragColor = sum;
  }
`;

const INJECT_FRAG = /* glsl */`
  uniform sampler2D tPrev;
  uniform vec2  uPos;
  uniform vec2  uVel;
  uniform float uMass;
  uniform float uRadius;
  varying vec2 vUv;

  void main() {
    vec4 c = texture2D(tPrev, vUv);
    vec2 d = vUv - uPos;
    float r = length(d);
    float fall = exp(-r / max(uRadius, 0.001));
    c.rg += uVel * fall;
    c.b  += uMass * fall;
    gl_FragColor = c;
  }
`;

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export class VelocityField {
  constructor(renderer, { resolution = 256 } = {}) {
    this.renderer = renderer;
    this.size     = resolution;

    // RGBA float RT pair for ping-pong. R/G = velocity, B = mass, A unused.
    const rtOpts = {
      type:        THREE.HalfFloatType,   // f16 — plenty for velocity range, half the bandwidth of FloatType
      format:      THREE.RGBAFormat,
      minFilter:   THREE.LinearFilter,
      magFilter:   THREE.LinearFilter,
      wrapS:       THREE.ClampToEdgeWrapping,
      wrapT:       THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.rtA = new THREE.WebGLRenderTarget(resolution, resolution, rtOpts);
    this.rtB = new THREE.WebGLRenderTarget(resolution, resolution, rtOpts);
    this.read  = this.rtA;
    this.write = this.rtB;

    this.updateMat = new THREE.ShaderMaterial({
      uniforms: {
        tPrev:           { value: null },
        uTexel:          { value: new THREE.Vector2(1 / resolution, 1 / resolution) },
        uVelDecay:       { value: 0.992 },   // velocity multiplier per frame
        uMassDecay:      { value: 0.985 },   // mass multiplier per frame (faster decay)
        uAdvectStrength: { value: 4.0 },     // how aggressively velocity carries itself
      },
      vertexShader:   VERT,
      fragmentShader: UPDATE_FRAG,
      depthTest:      false,
      depthWrite:     false,
    });

    this.injectMat = new THREE.ShaderMaterial({
      uniforms: {
        tPrev:    { value: null },
        uPos:     { value: new THREE.Vector2(-1, -1) },
        uVel:     { value: new THREE.Vector2(0, 0) },
        uMass:    { value: 0 },
        uRadius:  { value: 0.05 },
      },
      vertexShader:   VERT,
      fragmentShader: INJECT_FRAG,
      depthTest:      false,
      depthWrite:     false,
    });

    this.updateQuad = new FullScreenQuad(this.updateMat);
    this.injectQuad = new FullScreenQuad(this.injectMat);

    this._swap = this._swap.bind(this);
  }

  // Run one ping-pong step. Called from the main render loop each frame.
  // Cheap (256x256 quad pass) so safe to run unconditionally.
  step() {
    const prevTarget = this.renderer.getRenderTarget();
    this.updateMat.uniforms.tPrev.value = this.read.texture;
    this.renderer.setRenderTarget(this.write);
    this.updateQuad.render(this.renderer);
    this.renderer.setRenderTarget(prevTarget);
    this._swap();
  }

  // Stamp a velocity + mass impulse at UV `(x, y)` with exponential
  // falloff. velX / velY are in field-internal units (-8..8 ish);
  // mass is positive, decays a few hundred ms later. Radius is UV-space.
  inject(x, y, velX = 0, velY = 0, mass = 1.0, radius = 0.05) {
    const u = this.injectMat.uniforms;
    u.tPrev.value = this.read.texture;
    u.uPos.value.set(x, y);
    u.uVel.value.set(velX, velY);
    u.uMass.value = mass;
    u.uRadius.value = radius;
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.write);
    this.injectQuad.render(this.renderer);
    this.renderer.setRenderTarget(prevTarget);
    this._swap();
  }

  // The CURRENT field texture (after the latest step or inject).
  // Other passes sample this in their fragment shaders. R/G = velocity,
  // B = mass.
  getTexture() {
    return this.read.texture;
  }

  // Force the field back to zero. Used when an unrelated action (e.g.
  // seeding particles from voxels) needs to start from a clean state so
  // accumulated mouse/pinch impulses don't immediately blow the new
  // particles around.
  clear() {
    const prevTarget = this.renderer.getRenderTarget();
    const prevColor = new THREE.Color();
    this.renderer.getClearColor(prevColor);
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(this.rtA); this.renderer.clear(true, false, false);
    this.renderer.setRenderTarget(this.rtB); this.renderer.clear(true, false, false);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(prevColor, prevAlpha);
    this.read = this.rtA;
    this.write = this.rtB;
  }

  // Per-frame tunables exposed so a GUI can twiddle them live.
  get params() {
    return {
      velDecay:       this.updateMat.uniforms.uVelDecay.value,
      massDecay:      this.updateMat.uniforms.uMassDecay.value,
      advectStrength: this.updateMat.uniforms.uAdvectStrength.value,
    };
  }
  setVelDecay(v)       { this.updateMat.uniforms.uVelDecay.value = v; }
  setMassDecay(v)      { this.updateMat.uniforms.uMassDecay.value = v; }
  setAdvectStrength(v) { this.updateMat.uniforms.uAdvectStrength.value = v; }

  _swap() {
    const t = this.read;
    this.read = this.write;
    this.write = t;
  }

  dispose() {
    this.rtA.dispose();
    this.rtB.dispose();
    this.updateMat.dispose();
    this.injectMat.dispose();
    this.updateQuad.dispose();
    this.injectQuad.dispose();
  }
}
