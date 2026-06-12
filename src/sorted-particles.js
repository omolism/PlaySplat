// ---------------------------------------------------------------------------
// SortedParticles — port of cornusammonis "Tons of Spatial-Sorted Particles"
// (Shadertoy 2017). 4-buffer simulation:
//
//   Buffer A (ping-pong) — main sim. Sort window 5×5 with STRIDE=25 (wide),
//                          plus curl-noise advection of the stored 2D
//                          positions. Re-orders neighborhood quadrants
//                          per frame to dampen artifacts.
//   Buffer B           —   FULL=5, STRIDE=1 sort over Buffer A's output.
//   Buffer C           —   FULL=5, STRIDE=5 sort over Buffer B's output.
//   Buffer D (ping-pong)   For each screen pixel, finds closest stored
//                          particle position + accumulates gravity / minDist
//                          via an EWMA. THIS is what the display pass reads.
//
// All passes use texelFetch, so the ShaderMaterial.glslVersion is GLSL3.
// Particle data lives entirely on the GPU — only positions (vec2, xy in 0..1
// UV space) per pixel of the 128×128 sim grid (16k particles by default).
// Cost: ~40M shader ops/frame at 128² — runs at 60 fps on modern GPUs.
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

// Shared GLSL3 sort algorithm body — used by Buffers A, B, C. The only
// per-buffer differences are STRIDE, the iTime hash seeds for the random
// offset, REORDER offset, and Buffer A's extra curl-noise step. The macros
// are stringified and concatenated when the materials are built.
function buildSortShader({ STRIDE, hashSeed, reorderOffset, extras = "", finalExpr }) {
  return /* glsl */`
    precision highp float;
    precision highp int;
    uniform sampler2D iChannel0;
    uniform vec2  iResolution;
    uniform float iTime;
    uniform int   iFrame;
    in  vec2 vUv;
    out vec4 fragColor;

    #define T(d) texelFetch(iChannel0, d, 0).xy
    #define FULL 5
    #define STRIDE ${STRIDE}
    #define SORT_WINDOW (FULL*STRIDE)
    #define DIM (FULL*FULL)
    #define REORDER(k) ((iFrame+${reorderOffset}+k)%4)
    #define R(v) (vec2(v) / iResolution.xy)

    const vec3 MOD3 = vec3(0.1031, 0.11369, 0.13787);
    vec3 hash33(vec3 p3) {
      p3 = fract(p3 * MOD3);
      p3 += dot(p3, p3.yxz + 19.19);
      return -1.0 + 2.0 * fract(vec3(
        (p3.x + p3.y) * p3.z,
        (p3.x + p3.z) * p3.y,
        (p3.y + p3.z) * p3.x));
    }

    ${extras}

    void main() {
      ivec2 iFC = ivec2(gl_FragCoord.xy);
      ivec2 iuv = iFC;
      vec2 tx = 1.0 / iResolution.xy;
      vec2 pos = T(iuv);
      vec2 new_pos = pos;
      ivec2 iRes = ivec2(iResolution.xy);

      vec3 h = hash33(iTime * vec3(${hashSeed}));
      ivec2 offs = ivec2(float(SORT_WINDOW) * h.xy);

      ivec2 uvm = iuv + offs;
      ivec2 shift = (STRIDE + (uvm % STRIDE)) % STRIDE;
      ivec2 subp = ((SORT_WINDOW + ((uvm - shift) % SORT_WINDOW)) % SORT_WINDOW) / STRIDE;
      ivec2 subp_stride = STRIDE * subp;
      ivec2 base_uv = iuv - subp_stride;

      if (all(greaterThanEqual(base_uv, ivec2(0))) &&
          all(lessThanEqual(base_uv + STRIDE * FULL, iRes))) {
        bool del[DIM];
        vec2 sort_[DIM];
        vec2 posv[DIM];
        ivec2 order[DIM];

        for (int i = 0; i < DIM; i++) { del[i] = false; sort_[i] = vec2(0.0); posv[i] = vec2(0.0); }

        int MAX = DIM / 4;
        if (FULL % 2 == 1) { order[DIM - 1] = ivec2(FULL / 2); MAX = (DIM - 1) / 4; }

        int ic = 0, m = 0, id = FULL - 1;
        for (int i = 0; i < MAX; i++) {
          if (ic == id) { id = id - 2; ic = 0; m++; }
          order[4 * i + REORDER(0)] = ivec2(ic + m, id + m);
          order[4 * i + REORDER(1)] = ivec2(id + m, id - ic + m);
          order[4 * i + REORDER(2)] = ivec2(id - ic + m, m);
          order[4 * i + REORDER(3)] = ivec2(m, ic + m);
          ic++;
        }

        for (int i = 0; i < FULL; i++)
          for (int j = 0; j < FULL; j++)
            posv[i + j * FULL] = T(base_uv + STRIDE * ivec2(i, j));

        for (int i = DIM - 1; i >= 0; i--) {
          float closest_distance = 1e6;
          int closest_index = -1;
          vec2 tgt = R(base_uv + STRIDE * order[i]);
          int tgt_index = order[i].x + order[i].y * FULL;
          for (int j = 0; j < DIM; j++) {
            float d = distance(posv[j], tgt);
            if (d <= closest_distance && !del[j]) {
              closest_index = j;
              closest_distance = d;
            }
          }
          if (closest_index >= 0) {
            del[closest_index] = true;
            sort_[tgt_index] = posv[closest_index];
          }
        }
        new_pos = sort_[subp.x + subp.y * FULL];
      }

      ${finalExpr}
    }
  `;
}

// Buffer A — sort + curl-noise advect. Adds simplex_noise helper and uses
// it to derive a curl vector that nudges every particle each frame.
const BUFFER_A_EXTRAS = /* glsl */`
  float simplex_noise(vec3 p) {
    p *= 4.0;
    const float K1 = 0.333333333;
    const float K2 = 0.166666667;
    vec3 i = floor(p + (p.x + p.y + p.z) * K1);
    vec3 d0 = p - (i - (i.x + i.y + i.z) * K2);
    vec3 e = step(vec3(0.0), d0 - d0.yzx);
    vec3 i1 = e * (1.0 - e.zxy);
    vec3 i2 = 1.0 - e.zxy * (1.0 - e);
    vec3 d1 = d0 - (i1 - 1.0 * K2);
    vec3 d2 = d0 - (i2 - 2.0 * K2);
    vec3 d3 = d0 - (1.0 - 3.0 * K2);
    vec4 hh = max(0.6 - vec4(dot(d0,d0), dot(d1,d1), dot(d2,d2), dot(d3,d3)), 0.0);
    vec4 nv = hh * hh * hh * hh * vec4(
      dot(d0, hash33(i)),
      dot(d1, hash33(i + i1)),
      dot(d2, hash33(i + i2)),
      dot(d3, hash33(i + 1.0)));
    return dot(vec4(31.316), nv);
  }
`;

const BUFFER_A_FINAL = /* glsl */`
  vec2 uv = gl_FragCoord.xy / iResolution.xy;
  vec2 aspect = vec2(1.0, iResolution.y / iResolution.x);
  float delta = 1.0 * tx.x;
  float TIME = iTime / 10.0;
  float n  = simplex_noise(vec3(aspect * pos, TIME));
  float ny = simplex_noise(vec3(aspect * pos + vec2(0.0, delta), TIME));
  float nx = simplex_noise(vec3(aspect * pos + vec2(delta, 0.0), TIME));
  vec2 noiseV = vec2(nx, ny) - vec2(n);
  if (iFrame < 2) {
    fragColor = 0.5 + vec4(vec2(uv - 0.5).yx * vec2(1.0, -1.0), vec2(0.0));
  } else {
    vec2 curl = 0.5 * normalize(vec2(noiseV.y, -noiseV.x));
    fragColor = vec4(mod(new_pos + curl * tx.x, vec2(1.0)), vec2(0.0));
  }
`;

const BUFFER_BC_FINAL = "fragColor = vec4(new_pos, 0.0, 0.0);";

// Buffer D — gravity / minDist accumulator. Reads Buffer C (positions) + its
// own previous frame (EWMA state). Output: RGBA where xy = closest position,
// z = gravity, w = minDist (smoothed via EWMA).
const BUFFER_D_FRAG = /* glsl */`
  precision highp float;
  precision highp int;
  uniform sampler2D iChannel0;     // Buffer C — positions
  uniform sampler2D iChannel1;     // self previous frame — EWMA state
  uniform vec2  iResolution;
  in  vec2 vUv;
  out vec4 fragColor;

  #define T(d) texelFetch(iChannel0, d, 0).xy
  #define D(d) texelFetch(iChannel1, d, 0)
  #define WINDOW 3
  #define WIDTH (WINDOW * 2 + 1)
  #define DIM (WIDTH * WIDTH)
  #define TC 0.95

  void main() {
    vec2 uv = gl_FragCoord.xy / iResolution.xy;
    ivec2 iuv = ivec2(gl_FragCoord.xy);
    float gravity = 0.0;
    float minDist = 1e6;
    vec4 prevVec = D(iuv);
    vec2 closest = vec2(1e6);

    for (int i = -WINDOW; i <= WINDOW; i++) {
      for (int j = -WINDOW; j <= WINDOW; j++) {
        vec2 pos = T(iuv + ivec2(i, j));
        float d = distance(uv, pos);
        gravity += 1.0 / max(d * d, 1e-8);
        if (d < minDist) { minDist = d; closest = pos; }
      }
    }

    vec2 ewma;
    if (prevVec.zw == vec2(0.0)) {
      ewma = vec2(0.0, minDist);
    } else {
      float gravp = clamp(1e-8 * gravity, 0.0, 1.0);
      ewma = TC * prevVec.zw + (1.0 - TC) * vec2(gravp, minDist);
    }
    fragColor = vec4(closest, ewma);
  }
`;

// NOTE: THREE.js auto-injects `in vec3 position` and `in vec2 uv` for
// ShaderMaterial in GLSL3 mode (they come from the geometry's standard
// attributes). Redeclaring them here causes "redefinition" compile errors.
const VERT = /* glsl */`
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

function makeMat(frag, extraUniforms = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      iChannel0:   { value: null },
      iResolution: { value: new THREE.Vector2(1, 1) },
      iTime:       { value: 0 },
      iFrame:      { value: 0 },
      ...extraUniforms,
    },
    vertexShader:   VERT,
    fragmentShader: frag,
    depthTest:      false,
    depthWrite:     false,
  });
  mat.glslVersion = THREE.GLSL3;
  return mat;
}

function makeRT(size) {
  return new THREE.WebGLRenderTarget(size, size, {
    type:           THREE.HalfFloatType,
    format:         THREE.RGBAFormat,
    minFilter:      THREE.NearestFilter,
    magFilter:      THREE.NearestFilter,
    wrapS:          THREE.ClampToEdgeWrapping,
    wrapT:          THREE.ClampToEdgeWrapping,
    depthBuffer:    false,
    stencilBuffer:  false,
  });
}

export class SortedParticles {
  constructor(renderer, { resolution = 128 } = {}) {
    this.renderer = renderer;
    this.size     = resolution;
    this.iFrame   = 0;
    this.iTime    = 0;

    this.bufA1 = makeRT(resolution); this.bufA2 = makeRT(resolution);
    this.bufB  = makeRT(resolution);
    this.bufC  = makeRT(resolution);
    this.bufD1 = makeRT(resolution); this.bufD2 = makeRT(resolution);
    this.aRead = this.bufA1; this.aWrite = this.bufA2;
    this.dRead = this.bufD1; this.dWrite = this.bufD2;

    this.matA = makeMat(buildSortShader({
      STRIDE: 25, hashSeed: "-5.17, 14.94, -7.56",
      reorderOffset: 3, extras: BUFFER_A_EXTRAS, finalExpr: BUFFER_A_FINAL,
    }));
    this.matB = makeMat(buildSortShader({
      STRIDE: 1,  hashSeed: "13.93, -17.41, 9.38",
      reorderOffset: 1, finalExpr: BUFFER_BC_FINAL,
    }));
    this.matC = makeMat(buildSortShader({
      STRIDE: 5,  hashSeed: "7.34, 2.14, 12.73",
      reorderOffset: 2, finalExpr: BUFFER_BC_FINAL,
    }));
    this.matD = makeMat(BUFFER_D_FRAG, { iChannel1: { value: null } });

    this.quadA = new FullScreenQuad(this.matA);
    this.quadB = new FullScreenQuad(this.matB);
    this.quadC = new FullScreenQuad(this.matC);
    this.quadD = new FullScreenQuad(this.matD);
  }

  step(dt) {
    // Cheap-out gate: skip the 4-buffer sim entirely when the caller has
    // signalled it's not consuming the output (e.g. display overlay is
    // disabled). Saves ~40M ALU ops per frame at 128². Re-enable just
    // re-starts the sim from scratch (iFrame=0 reseeds Buffer A).
    if (this.skipUpdate) return;
    this.iFrame++;
    this.iTime += dt;
    const sz = this.size;
    const prev = this.renderer.getRenderTarget();

    // --- Buffer A ---
    const uA = this.matA.uniforms;
    uA.iChannel0.value   = this.aRead.texture;
    uA.iResolution.value.set(sz, sz);
    uA.iTime.value       = this.iTime;
    uA.iFrame.value      = this.iFrame;
    this.renderer.setRenderTarget(this.aWrite);
    this.quadA.render(this.renderer);
    const aTmp = this.aRead; this.aRead = this.aWrite; this.aWrite = aTmp;

    // --- Buffer B ---
    const uB = this.matB.uniforms;
    uB.iChannel0.value   = this.aRead.texture;
    uB.iResolution.value.set(sz, sz);
    uB.iTime.value       = this.iTime;
    uB.iFrame.value      = this.iFrame;
    this.renderer.setRenderTarget(this.bufB);
    this.quadB.render(this.renderer);

    // --- Buffer C ---
    const uC = this.matC.uniforms;
    uC.iChannel0.value   = this.bufB.texture;
    uC.iResolution.value.set(sz, sz);
    uC.iTime.value       = this.iTime;
    uC.iFrame.value      = this.iFrame;
    this.renderer.setRenderTarget(this.bufC);
    this.quadC.render(this.renderer);

    // --- Buffer D ---
    const uD = this.matD.uniforms;
    uD.iChannel0.value   = this.bufC.texture;
    uD.iChannel1.value   = this.dRead.texture;
    uD.iResolution.value.set(sz, sz);
    this.renderer.setRenderTarget(this.dWrite);
    this.quadD.render(this.renderer);
    const dTmp = this.dRead; this.dRead = this.dWrite; this.dWrite = dTmp;

    this.renderer.setRenderTarget(prev);
  }

  // RGBA: xy = closest position, z = gravity (EWMA), w = minDist (EWMA).
  // Downstream display passes typically sample exp(-w * k) for a glow.
  getOutputTexture() { return this.dRead.texture; }

  dispose() {
    [this.bufA1, this.bufA2, this.bufB, this.bufC, this.bufD1, this.bufD2]
      .forEach(rt => rt.dispose());
    [this.matA, this.matB, this.matC, this.matD].forEach(m => m.dispose());
    [this.quadA, this.quadB, this.quadC, this.quadD].forEach(q => q.dispose());
  }
}
