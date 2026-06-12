// ---------------------------------------------------------------------------
// Shared FX GLSL — concise plain-GLSL equivalent of the splat dyno modifier,
// used by Voxelizer and Quadizer vertex shaders so cubes / billboards animate
// alongside the splat layer when the user triggers a scan effect.
//
// API:
//   include FX_UNIFORMS in the shader's uniform declarations
//   include FX_FUNCTIONS in the shader's global block
//   call vec3 off = fxOffset(center); position += off;
//   call vec3 tint = fxColorTint(baseColor, center); fragColor = tint;
//
// The full dyno modifier in effects.js does more (per-splat fbm, RGB chroma,
// hero particles, etc.) but for instanced primitives a simpler approximation
// reads correctly and is much cheaper.
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
`;

export const FX_FUNCTIONS = /* glsl */`
  // Pseudo-random hash (matches the splat dyno globals for visual consistency)
  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }

  // Position displacement applied to a primitive center, in object space.
  // Returns a vec3 to be added to the input center.
  vec3 fxOffset(vec3 center) {
    if (uActive < 0.5) return vec3(0.0);
    vec3 toHit = center - uHit;
    float dist = length(toHit);
    vec3 dir   = dist > 1e-5 ? toHit / dist : vec3(0.0, 1.0, 0.0);

    float t      = uTime;
    float tNorm  = clamp(t / max(uDuration, 1e-4), 0.0, 1.0);
    float s      = clamp(uEffectStrength, 0.0, 1.0);

    vec3 jitter = (hash33(center * 17.137) - 0.5) * 2.0;
    vec3 off = vec3(0.0);

    if (uEffect == 0) {
      // Wave & Tint — outward push along radial direction
      float ring = smoothstep(uRadius, 0.0, dist);
      float wave = sin(t * uSpeed - dist * 5.0) * exp(-t * 0.7) * ring;
      off  = dir    * wave * uIntensity * 0.6
           + jitter * wave * uIntensity * 0.30;
    } else if (uEffect == 1) {
      // Dissolve & Reform — explode/reform with optional wind drift
      float falloff = smoothstep(uRadius, 0.0, dist);
      float fwd = smoothstep(0.0, 0.50, tNorm);
      float rev = smoothstep(0.50, 1.0, tNorm);
      float disp = fwd * (1.0 - rev);
      vec3 flyDir = normalize(jitter + dir * 0.4 + vec3(0.0, 0.7, 0.0) + uWindDir * 1.4);
      off  = flyDir * disp * falloff * uIntensity * 1.5
           + uWindDir * disp * falloff * 0.6;
    } else {
      // Scan Line — pop on the wavefront
      float waveFront = t * uSpeed;
      float band      = smoothstep(max(uRadius * 0.08, 0.04), 0.0,
                                   abs(dist - waveFront));
      float reachMask = smoothstep(uRadius * 1.3, 0.0, dist);
      float scan      = band * reachMask;
      off  = dir    * scan * uIntensity * 0.18
           + jitter * scan * uIntensity * 0.10;
    }
    // Cubes / billboards are static primitives — clamp the displacement so
    // they only "wiggle" in response to a click rather than fly out of frame
    // like the soft splat layer can. The splat dyno uses its own (larger)
    // intensity in effects.js; this scalar only affects the instancers.
    return off * s * 0.3;
  }

  // Color tint applied based on the same FX state. Returns the tinted color.
  vec3 fxColorTint(vec3 baseColor, vec3 center) {
    if (uActive < 0.5) return baseColor;
    float t      = uTime;
    float s      = clamp(uEffectStrength, 0.0, 1.0);
    float dist   = length(center - uHit);
    float crest  = 0.0;
    if (uEffect == 0) {
      float ring = smoothstep(uRadius, 0.0, dist);
      float wave = sin(t * uSpeed - dist * 5.0) * exp(-t * 0.7) * ring;
      crest = pow(abs(wave), 2.0);
    } else if (uEffect == 1) {
      float falloff = smoothstep(uRadius, 0.0, dist);
      float tNorm = clamp(t / max(uDuration, 1e-4), 0.0, 1.0);
      float fwd = smoothstep(0.0, 0.50, tNorm);
      float rev = smoothstep(0.50, 1.0, tNorm);
      crest = falloff * fwd * (1.0 - rev) * 0.7;
    } else {
      float waveFront = t * uSpeed;
      float band      = smoothstep(max(uRadius * 0.08, 0.04), 0.0,
                                   abs(dist - waveFront));
      float reachMask = smoothstep(uRadius * 1.3, 0.0, dist);
      crest = band * reachMask;
    }
    crest *= s;
    vec3 tinted = mix(baseColor, uColor, clamp(crest * 1.4, 0.0, 0.85));
    tinted += uColor * crest * uEmissive * 0.35;
    return tinted;
  }
`;
