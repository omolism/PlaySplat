// ---------------------------------------------------------------------------
// Shared FX GLSL — plain-GLSL equivalent of the splat dyno modifier, used by
// Voxelizer and Quadizer vertex shaders so cubes / billboards animate
// alongside the splat layer for ALL 7 effects.
//
// API (preferred — one evaluation per vertex):
//   include FX_UNIFORMS in the shader's uniform declarations
//   include FX_FUNCTIONS in the shader's global block
//   vec4 fx = fxEval(center);          // xyz = displacement, w = tint crest
//   position += fx.xyz;
//   color = fxTintApply(baseColor, fx.w);
//
// Legacy wrappers fxOffset()/fxColorTint() remain for callers that want the
// two-call form, at the cost of evaluating the field twice.
//
// The dyno modifier in effects.js stays the visual reference: it adds
// per-splat fbm wisps, covariance streaks, hero particles, and alpha shaping
// that instanced primitives can't express. Each branch here ports the same
// MOTION (mask, envelope, direction field) so the derived layers move in
// sync with the splats, with magnitudes tamed via FX_DAMP because hard
// primitives read as torn apart at full splat amplitudes.
// ---------------------------------------------------------------------------

export const FX_UNIFORMS = /* glsl */`
  uniform float uTime;
  uniform vec3  uHit;
  uniform vec3  uColor;
  uniform float uRadius;
  uniform float uSpeed;
  uniform float uIntensity;
  uniform int   uEffect;
  uniform float uActive;
  uniform float uDuration;
  uniform float uEffectStrength;
  uniform vec3  uWindDir;
  uniform float uEmissive;
  uniform float uNoiseScale;
  uniform float uFlyMax;
`;

export const FX_FUNCTIONS = /* glsl */`
  // Global damp on instancer displacement relative to the splat layer.
  // Splats are soft ellipsoids that can fly and still read; cubes and
  // billboards are hard primitives that look shattered at the same
  // amplitude. 0.5 keeps the motion clearly legible but anchored.
  #define FX_DAMP 0.5

  // Pseudo-random hashes (match the splat dyno globals for consistency)
  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  // Single-octave value noise — the cheap workhorse for the flow fields.
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
    return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
               mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
  }

  // One evaluation of the FX field at a primitive center (object space —
  // shared with the splat, so uHit applies directly).
  //   returns: xyz = displacement to ADD to the center, w = tint crest 0..1
  vec4 fxEval(vec3 center) {
    if (uActive < 0.5) return vec4(0.0);
    vec3  toHit = center - uHit;
    float dist  = length(toHit);
    vec3  dir   = dist > 1e-5 ? toHit / dist : vec3(0.0, 1.0, 0.0);

    float t     = uTime;
    float tNorm = clamp(t / max(uDuration, 1e-4), 0.0, 1.0);
    float s     = clamp(uEffectStrength, 0.0, 1.0);

    vec3 jitter = (hash33(center * 17.137) - 0.5) * 2.0;
    vec3 off    = vec3(0.0);
    float crest = 0.0;

    if (uEffect == 0) {
      // ---- Wave & Tint — outward radial push -------------------------------
      float ring = smoothstep(uRadius, 0.0, dist);
      float wave = sin(t * uSpeed - dist * 5.0) * exp(-t * 0.7) * ring;
      off   = dir * wave * uIntensity * 0.6 + jitter * wave * uIntensity * 0.30;
      crest = pow(abs(wave), 2.0);

    } else if (uEffect == 1) {
      // ---- Dissolve & Reform — explode / reform with wind drift ------------
      float falloff = smoothstep(uRadius, 0.0, dist);
      float fwd  = smoothstep(0.0, 0.50, tNorm);
      float rev  = smoothstep(0.50, 1.0, tNorm);
      float disp = fwd * (1.0 - rev);
      vec3 flyDir = normalize(jitter + dir * 0.4 + vec3(0.0, 0.7, 0.0) + uWindDir * 1.4);
      off   = flyDir * disp * falloff * uIntensity * 1.5
            + uWindDir * disp * falloff * 0.6;
      crest = falloff * disp * 0.7;

    } else if (uEffect == 2) {
      // ---- Scan Line — pop on the travelling wavefront ---------------------
      float waveFront = t * uSpeed;
      float band      = smoothstep(max(uRadius * 0.08, 0.04), 0.0,
                                   abs(dist - waveFront));
      float reachMask = smoothstep(uRadius * 1.3, 0.0, dist);
      float scan      = band * reachMask;
      off   = dir * scan * uIntensity * 0.18 + jitter * scan * uIntensity * 0.10;
      crest = scan;

    } else if (uEffect == 3) {
      // ---- Spiral Smear — orbit around uHit + wind tear-off ----------------
      // Same annulus band + staggered envelope as the dyno: the subject near
      // uHit holds still, a ring of primitives shears around it.
      float reach = uRadius * 1.6;
      float inner = uRadius * 0.50;
      float band  = smoothstep(inner * 0.4, inner, dist)
                  * smoothstep(reach, reach * 0.55, dist);
      float a        = clamp(tNorm / 0.9, 0.0, 1.0);
      float strength = pow(a, 0.6) * (1.0 - pow(1.0 - a, 4.0));
      float ang = (t * uSpeed * 0.45 + dist * uIntensity * 1.4 + jitter.x * 0.6)
                * strength;
      float cs = cos(ang), sn = sin(ang);
      vec3 r    = toHit;
      vec3 rRot = vec3(r.x * cs - r.z * sn, r.y, r.x * sn + r.z * cs);
      vec3 drift = uWindDir * dist * uFlyMax * 0.18 * strength
                 + jitter * dist * 0.06 * strength;
      off   = (rRot + drift - r) * band;
      crest = band * strength * 0.6;

    } else if (uEffect == 4) {
      // ---- Vortex Drift — pseudo-curl flow + tangential swirl --------------
      // The dyno computes a true finite-difference curl (18 noise taps); for
      // instancers a 3-tap flow vector plus an explicit tangent term reads
      // the same at a fraction of the cost.
      float reach = uRadius * 1.8;
      float mask  = 1.0 - smoothstep(reach * 0.55, reach, dist);
      float ft    = t * uSpeed * 0.22;
      vec3  np    = center * uNoiseScale * 0.6 + uWindDir * ft * 0.4;
      vec3 flow = vec3(
        vnoise(np + vec3(0.0,   0.0,  ft)),
        vnoise(np + vec3(31.41, 0.0,  ft)),
        vnoise(np + vec3(0.0,  47.13, ft))) - 0.5;
      vec3 tangent = normalize(cross(dir, vec3(0.0, 1.0, 0.0)) + vec3(0.0, 1e-4, 0.0));
      float env = smoothstep(0.0, 0.25, tNorm) * (1.0 - smoothstep(0.45, 1.0, tNorm));
      float phase = 1.0 + 0.5 * sin(t * uSpeed * 0.35 + jitter.x * 6.2831);
      off   = (flow * 2.0 + tangent * 0.6) * uIntensity * uRadius * 0.45
            * mask * env * phase
            + uWindDir * uIntensity * mask * env * 0.18;
      crest = mask * env * 0.7;

    } else if (uEffect == 6) {
      // ---- Slime Molds — ridge-vein gradient pull --------------------------
      // Ridge-folded value noise forms thin veins; primitives slide up the
      // gradient toward vein centers, migrating as the field drifts.
      float reach = uRadius * 1.8;
      float mask  = 1.0 - smoothstep(reach * 0.55, reach, dist);
      float smScale = max(uNoiseScale * 1.2, 0.05);
      float smT     = t * uSpeed * 0.18;
      vec3  smP     = (center - uHit) * smScale + uWindDir * smT;
      float e   = 0.10;
      float v   = 1.0 - abs(2.0 * vnoise(smP) - 1.0);
      float vx  = 1.0 - abs(2.0 * vnoise(smP + vec3(e, 0.0, 0.0)) - 1.0);
      float vy  = 1.0 - abs(2.0 * vnoise(smP + vec3(0.0, e, 0.0)) - 1.0);
      float vz  = 1.0 - abs(2.0 * vnoise(smP + vec3(0.0, 0.0, e)) - 1.0);
      vec3 grad = vec3(vx - v, vy - v, vz - v) / e;
      float env = smoothstep(0.0, 0.20, tNorm) * (1.0 - smoothstep(0.50, 1.0, tNorm));
      vec3 pull = grad * (uIntensity * 0.30 / smScale) * mask * env;
      float mag = min(length(pull), uIntensity * 0.8);
      off   = (length(pull) > 1e-5 ? pull / length(pull) : vec3(0.0)) * mag
            + jitter * 0.018 * uIntensity * mask * env;
      crest = mask * env * 0.6;

    } else {
      // ---- Feather Roots — outward branching fibers ------------------------
      // Radial outward push with a smooth noise tilt: neighbours sample
      // similar noise, follow similar paths, and read as branches. Inner
      // no-go zone keeps the spawn point intact (the dyno's "hole" fix).
      float reach  = uRadius * 2.0;
      float inner  = uRadius * 0.15;
      float mask   = (1.0 - smoothstep(reach * 0.5, reach, dist))
                   * smoothstep(0.0, inner, dist);
      vec3 np = center * uNoiseScale * 0.7 + vec3(t * 0.25, 0.0, 0.0);
      vec3 perturb = vec3(
        vnoise(np),
        vnoise(np + vec3(5.31, 7.13, 0.0)),
        vnoise(np + vec3(11.7, 3.27, 0.0))) - 0.5;
      vec3 branchDir = normalize(dir + perturb * uFlyMax * 0.45 + uWindDir * 0.15);
      float feath = vnoise(center * uNoiseScale * 1.5 + vec3(0.0, t * 0.45, 0.0));
      float shell = sin(dist * 1.5 - t * uSpeed * 0.5);
      float env = smoothstep(0.0, 0.18, tNorm) * (1.0 - smoothstep(0.48, 1.0, tNorm));
      float speed = uSpeed * 0.28 * (0.30 + 1.5 * feath) * (0.65 + 0.35 * shell);
      off   = branchDir * uIntensity * speed * mask * env * 0.55;
      crest = mask * env * 0.7;
    }

    return vec4(off * s * FX_DAMP, clamp(crest * s, 0.0, 1.0));
  }

  // Apply the crest from fxEval().w as a MULTIPLICATIVE tint, matching the
  // splat dyno semantics: rgba.rgb *= mix(vec3(1.0), uColor, crest).
  // Critical: when the Color tint checkbox is OFF the dyno sets uColor to
  // WHITE, and multiply-by-white is a no-op. The earlier lerp-toward-color
  // + additive emissive version washed the whole instancer layer white in
  // exactly that state.
  vec3 fxTintApply(vec3 baseColor, float crest) {
    return baseColor * mix(vec3(1.0), uColor, clamp(crest, 0.0, 1.0));
  }

  // ---- Legacy two-call wrappers (evaluate the field twice — prefer fxEval)
  vec3 fxOffset(vec3 center)                      { return fxEval(center).xyz; }
  vec3 fxColorTint(vec3 baseColor, vec3 center)   { return fxTintApply(baseColor, fxEval(center).w); }
`;
