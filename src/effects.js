import { dyno } from "@sparkjsdev/spark";
import * as THREE from "three";
import GUI from "lil-gui";

// ---------------------------------------------------------------------------
// FX-grade scan/dissolve effects for SplatMesh
//
// Design notes (FX artist perspective):
//   - All randomness driven by a smooth 3D value noise + fbm so the effect
//     reads as a textured material, not as procedural code.
//   - Dissolve uses a "threshold map" = signed distance to hit + fbm offset,
//     so the burn front breaks up organically instead of being a clean ring.
//   - Each effect has a sharp emissive edge band (FX cliché but it works).
//     Splats inside the edge are pushed in size & color before being released.
//   - Per-splat seed (hash of position) drives unique fly-direction, delay,
//     and hero/extra factor so the dissolved cloud has depth instead of moving
//     as a single shell.
//   - RGB phase-shift on Wave & Tint gives a free chromatic-aberration look.
// ---------------------------------------------------------------------------

export const uniforms = {
  time:        dyno.dynoFloat(0.0),
  hit:         dyno.dynoVec3(new THREE.Vector3(0, 0, 1e6)),
  color:       dyno.dynoVec3(new THREE.Vector3(0.8, 0.8, 0.8)),
  radius:      dyno.dynoFloat(2.0),
  speed:       dyno.dynoFloat(4.0),
  intensity:   dyno.dynoFloat(0.6),
  effect:      dyno.dynoInt(0),
  active:      dyno.dynoFloat(0.0),
  duration:    dyno.dynoFloat(2.5),
  noiseScale:  dyno.dynoFloat(1.0),
  edgeWidth:   dyno.dynoFloat(0.18),
  emissive:    dyno.dynoFloat(2.5),

  // ---- Independent layer visibility (NEW) ----
  // Each layer can be shown/hidden independently. Gaussian and Point share the
  // same SplatMesh, so they're mutually exclusive sub-forms (picked via
  // splatSubform), but Splat / Quad / Voxel layers can all be visible at once.
  //
  //   splatSubform : 0 = Gaussian (soft falloff), 1 = Point (isotropic dots)
  //   splatVis     : 0..1 fade for SplatMesh (Gaussian or Point — whichever sub-form)
  //   quadVis      : 0..1 fade for Quadizer billboards
  //   voxelVis     : 0..1 fade for Voxelizer cubes
  // splatSubform lerps continuously between 0 (Gaussian) and 1 (Point) so the
  // segmented toggle animates instead of snapping.
  splatSubform: dyno.dynoFloat(0.0),
  splatVis:    dyno.dynoFloat(1.0),
  quadVis:     dyno.dynoFloat(0.0),
  voxelVis:    dyno.dynoFloat(0.0),
  pointSize:   dyno.dynoFloat(0.0015),
  quadSize:    dyno.dynoFloat(0.0064),
  voxelSize:   dyno.dynoFloat(0.013),

  // Global multiplier on the effect's contribution (1 = full, 0 = no effect).
  effectStrength: dyno.dynoFloat(0.0),

  // ---- Dissolve-specific FX knobs ----
  // windDir         : world-direction drift for dissolved particles (also bends edge)
  // edgeRagged      : 0 = smooth boundary, 1 = fbm-distorted ragged boundary
  // wispAmt         : 0 = uniform alpha, 1 = noise-driven wisps & smoke gradient
  // flyMax          : max distance multiplier for hero particles (1=mild, 6=spray)
  windDir:    dyno.dynoVec3(new THREE.Vector3(0, 0, 0)),
  edgeRagged: dyno.dynoFloat(0.6),
  wispAmt:    dyno.dynoFloat(0.7),
  flyMax:     dyno.dynoFloat(3.5),

  // ---- Mask reveal (palm-driven) ----
  // Inside the mask, pointMode is LOCALLY inverted: if the scene is currently
  // crystallized, a moving "hole" lets you peek at the underlying splats;
  // if the scene is splats, the mask reveals the crystallized form within.
  maskActive: dyno.dynoFloat(0.0),                        // 0 / 1 toggle
  maskCenter: dyno.dynoVec3(new THREE.Vector3()),         // object-space
  maskRadius: dyno.dynoFloat(0.6),                        // world units
  maskShape:  dyno.dynoInt(0),                            // 0 = sphere, 1 = cube
  maskSoft:   dyno.dynoFloat(0.25),                       // soft-edge fraction
};

export const params = {
  effect: "Wave & Tint",
  // Color tinting is OPT-IN. The default `colorOn = false` forces
  // uniforms.color to neutral white inside applyParams, which makes
  // Scan Line (the only effect that still consumes uColor in the
  // shader; the other seven explicitly removed it) render fully
  // monochrome — matching the project's monochrome rule out of the
  // box. Toggling Color tint ON in lil-gui reveals the picker below
  // and pipes its value through to the shader uniform, so a user
  // who wants colored Scan Line FX gets one tap to opt in.
  colorOn: false,
  color: "#cccccc",
  radius: 2.0,
  speed: 4.0,
  intensity: 0.6,
  duration: 2.5,
  noiseScale: 1.0,
  edgeWidth: 0.18,
  emissive: 2.5,

  // Layer toggles (true = visible, false = hidden). On toggle the controller
  // animates the corresponding uniform 0↔1 smoothly.
  splatLayer:  true,
  quadLayer:   false,
  voxelLayer:  false,
  splatSubform: "Gaussian",   // "Gaussian" | "Point"
  quadShape:    "quad",       // "quad" | "circle" — Quadizer subform
  voxelShape:   "cube",       // "cube" | "sphere" — Voxelizer subform
  pointSize: 0.0025,
  quadSize:  0.0064,
  voxelSize: 0.013,
  fadeTail: 0.9,              // tail-fade duration (s) for one-shot FX

  maskShape: "Sphere",
  maskRadius: 0.6,
  maskSoft: 0.25,

  windX: 0.0,
  windY: 0.0,
  windZ: 0.0,
  edgeRagged: 0.6,
  wispAmt:    0.7,
  flyMax:     3.5,
};

const SUBFORM_INDEX = { Gaussian: 0, Point: 1 };
const MASK_SHAPE_INDEX = { Sphere: 0, Cube: 1 };

const EFFECT_INDEX = {
  "Wave & Tint": 0,
  "Dissolve & Reform": 1,
  "Scan Line": 2,
  "Spiral Smear": 3,
  "Vortex Drift": 4,
  "Chaotic Particles": 5,
  "Slime Molds": 6,
  "Feather Roots": 7,
};

export function createScanModifier() {
  return dyno.dynoBlock(
    { gsplat: dyno.Gsplat },
    { gsplat: dyno.Gsplat },
    ({ gsplat }) => {
      const shader = new dyno.Dyno({
        inTypes: {
          gsplat:      dyno.Gsplat,
          uTime:       "float",
          uHit:        "vec3",
          uColor:      "vec3",
          uRadius:     "float",
          uSpeed:      "float",
          uIntensity:  "float",
          uEffect:     "int",
          uActive:     "float",
          uDuration:   "float",
          uNoiseScale: "float",
          uEdgeWidth:  "float",
          uEmissive:   "float",
          uSplatSubform: "float",
          uSplatVis:     "float",
          uPointSize:    "float",
          uEffectStrength: "float",
          uMaskActive: "float",
          uMaskCenter: "vec3",
          uMaskRadius: "float",
          uMaskShape:  "int",
          uMaskSoft:   "float",
          uWindDir:    "vec3",
          uEdgeRagged: "float",
          uWispAmt:    "float",
          uFlyMax:     "float",
        },
        outTypes: { gsplat: dyno.Gsplat },
        globals: () => [
          dyno.unindent(`
            // ---- Hashing & noise ------------------------------------------
            float hash11(float p) {
              p = fract(p * 0.1031);
              p *= p + 33.33;
              p *= p + p;
              return fract(p);
            }
            vec3 hash33(vec3 p) {
              p = fract(p * vec3(0.1031, 0.1030, 0.0973));
              p += dot(p, p.yxz + 33.33);
              return fract((p.xxy + p.yxx) * p.zyx);
            }

            // Smooth 3D value noise (cheap, plenty of detail for FX)
            float vnoise(vec3 p) {
              vec3 i = floor(p);
              vec3 f = fract(p);
              f = f * f * (3.0 - 2.0 * f);
              float n000 = hash33(i + vec3(0,0,0)).x;
              float n100 = hash33(i + vec3(1,0,0)).x;
              float n010 = hash33(i + vec3(0,1,0)).x;
              float n110 = hash33(i + vec3(1,1,0)).x;
              float n001 = hash33(i + vec3(0,0,1)).x;
              float n101 = hash33(i + vec3(1,0,1)).x;
              float n011 = hash33(i + vec3(0,1,1)).x;
              float n111 = hash33(i + vec3(1,1,1)).x;
              float x0 = mix(n000, n100, f.x);
              float x1 = mix(n010, n110, f.x);
              float x2 = mix(n001, n101, f.x);
              float x3 = mix(n011, n111, f.x);
              float y0 = mix(x0, x1, f.y);
              float y1 = mix(x2, x3, f.y);
              return mix(y0, y1, f.z);
            }
            // 3-octave fbm — adds the "burn paper" raggedness
            float fbm(vec3 p) {
              float v = 0.0;
              float a = 0.5;
              for (int i = 0; i < 3; i++) {
                v += a * vnoise(p);
                p *= 2.07;
                a *= 0.5;
              }
              return v;
            }
            // Symmetric pulse around center, falls off over width
            float pulse(float x, float center, float width) {
              return smoothstep(width, 0.0, abs(x - center));
            }
            // Smooth edge band: peaks at threshold, falls off in both directions
            float edgeBand(float val, float threshold, float width) {
              return pulse(val, threshold, width);
            }
            // Color helpers
            vec3 toLinear(vec3 c) { return c; } // working in linear-ish already

            // ---- 3D Worley / cellular noise ------------------------------
            // Returns distance to the nearest randomised cell point. Produces
            // organic blob clusters — splats in the same cell get similar
            // values, giving group-coherent variation instead of pure-random.
            float cellular(vec3 p) {
              vec3 i = floor(p);
              vec3 f = fract(p);
              float minDist = 1.0;
              for (int x = -1; x <= 1; x++) {
                for (int y = -1; y <= 1; y++) {
                  for (int z = -1; z <= 1; z++) {
                    vec3 nb   = vec3(float(x), float(y), float(z));
                    vec3 pt   = hash33(i + nb);
                    vec3 diff = nb + pt - f;
                    minDist   = min(minDist, dot(diff, diff));
                  }
                }
              }
              return sqrt(minDist);                // 0 .. ~1.4
            }

            // ---- Quaternion helpers (xyz=axis*sin(θ/2), w=cos(θ/2)) -------
            vec4 quatFromUnit(vec3 d) {
              // Build the shortest-arc quaternion rotating +X onto d (unit).
              vec3 fromV = vec3(1.0, 0.0, 0.0);
              float c = dot(fromV, d);
              if (c < -0.9999) return vec4(0.0, 1.0, 0.0, 0.0);  // 180° around Y
              vec3 ax = cross(fromV, d);
              vec4 q  = vec4(ax, 1.0 + c);
              return q / length(q);
            }
            vec4 quatNlerp(vec4 a, vec4 b, float t) {
              // Sign-aware nlerp — flip b if dot is negative so we take short path
              float d = dot(a, b);
              vec4  bb = d < 0.0 ? -b : b;
              vec4  q  = mix(a, bb, t);
              return q / max(length(q), 1e-6);
            }
          `),
        ],
        statements: ({ inputs, outputs }) =>
          dyno.unindentLines(`
            ${outputs.gsplat} = ${inputs.gsplat};
            if (${inputs.uActive} >= 0.5) {
              vec3 center  = ${inputs.gsplat}.center;
              vec3 scales  = ${inputs.gsplat}.scales;
              vec4 rgba    = ${inputs.gsplat}.rgba;

              // Per-splat seed — same per frame, varies per splat
              vec3  seed   = ${inputs.gsplat}.center;
              vec3  rand3  = hash33(seed * 17.137);
              float rand1  = rand3.x;
              float rand2  = rand3.y;
              float rand3v = rand3.z;

              // Hit-space coordinates
              vec3  toHit  = center - ${inputs.uHit};
              float dist   = length(toHit);
              vec3  dir    = dist > 1e-5 ? toHit / dist : vec3(0.0, 1.0, 0.0);

              float t      = ${inputs.uTime};
              float tNorm  = clamp(t / max(${inputs.uDuration}, 1e-4), 0.0, 1.0);
              float life   = 1.0 - tNorm;

              // Noise sampled in object space; uNoiseScale tunes chunkiness
              vec3  np     = (center - ${inputs.uHit}) * ${inputs.uNoiseScale};
              float n      = fbm(np * 1.5);                 // 0..1
              float nSigned= n * 2.0 - 1.0;                 // -1..1

              if (${inputs.uEffect} == 0) {
                // ==============================================================
                // Effect 0 — Wave & Tint  (richer ripple, noisy front, RGB shift)
                // ==============================================================
                float reach   = ${inputs.uRadius};
                float ringMask= smoothstep(reach, 0.0, dist);

                // Two superposed waves of different freqs → less monotone
                float phase   = t * ${inputs.uSpeed} - dist * 5.0;
                float wave1   = sin(phase + nSigned * 1.2) * exp(-t * 0.7);
                float wave2   = sin(phase * 1.7 + nSigned * 2.0) * exp(-t * 0.9) * 0.4;
                float wave    = (wave1 + wave2) * ringMask;

                // Position: outward push along radial, plus directional jitter
                vec3 jitter   = (rand3 - 0.5) * 2.0;
                center += dir    * wave * ${inputs.uIntensity} * 0.6;
                center += jitter * wave * ${inputs.uIntensity} * 0.30;

                // RGB chromatic separation — sample wave at phase-shifted distances
                float w_r = sin(phase + 0.6 + nSigned * 1.2) * exp(-t * 0.7) * ringMask;
                float w_g = wave1                                              * ringMask;
                float w_b = sin(phase - 0.6 + nSigned * 1.2) * exp(-t * 0.7) * ringMask;
                vec3 chroma = vec3(pow(abs(w_r), 2.0), pow(abs(w_g), 2.0), pow(abs(w_b), 2.0));

                // Optional per-splat tint on the wave crest. uColor is
                // (1,1,1) when the user hasn't opted into Color tint (the
                // checkbox in FX → Core), so the multiplier collapses to
                // identity and this line is a no-op — splat RGB stays
                // clean and the project's monochrome rule holds out of the
                // box. When the user toggles Color tint ON and picks a
                // colour, the wave-shaped factor mixes uColor into the
                // multiplier on the ripple crest, so the tint pulses with
                // the ripple instead of flat-painting the whole splat.
                // tintAmt peaks at the crest and falls off with the
                // wave's exponential decay, so the colour settles back
                // to the original splat as the ripple dies.
                float tintAmt  = clamp(abs(wave), 0.0, 1.0);
                vec3  tintMult = mix(vec3(1.0), ${inputs.uColor}, tintAmt * 0.9);
                rgba.rgb      *= tintMult;

                // Subtle "pop" in size on the wave crest
                float pop = clamp(pow(abs(wave), 3.0), 0.0, 1.0);
                scales *= 1.0 + pop * 0.25;

              } else if (${inputs.uEffect} == 1) {
                // ==============================================================
                // Effect 1 — Dissolve & Reform   (the FX-grade rewrite)
                //
                // We define a per-splat "burn coordinate":
                //     b = dist + noise * radius * 0.45
                // and an animated cutoff that sweeps b from 0 → radius and
                // back to 0. Splats whose b ≤ cutoff are "burnt":
                //   • in [cutoff − edge, cutoff]      → edge band (emissive)
                //   • in [0, cutoff − edge)           → dissolved (flying / fading)
                // ==============================================================
                // ----- Noise-warped radius for hair-like ragged boundary -----
                float radiusFx     = ${inputs.uRadius} * 1.4;
                float edgeNoise01  = fbm(seed * 9.0 + vec3(0.13, 0.27, 0.41));
                float edgeBend     = edgeNoise01 * 2.0 - 1.0;                  // -1..1
                float effRadius    = radiusFx * (1.0 + edgeBend * ${inputs.uEdgeRagged} * 0.55);
                float burn         = dist + nSigned * effRadius * 0.45;

                // Sweep: 0..0.5 burn outward, 0.5..1 reform inward (one-shot click path).
                float p   = tNorm;
                float fwd = smoothstep(0.0, 0.50, p);
                float rev = smoothstep(0.50, 1.0, p);
                float cutoffTime = mix(0.0, effRadius, fwd) * (1.0 - rev) + mix(effRadius, 0.0, rev) * rev;

                // ---- Effector-sphere override (hand-tracking goal) ----------
                // When uMaskActive is held high, replace the time sweep with a
                // spatial sphere mask centered on uMaskCenter. Splats inside
                // the sphere stay dissolved as long as the hand is there;
                // splats outside snap back to origin (gone=0 in their case).
                // Matches the TD Gaussian-splat effector reference.
                float effDist = length(center - ${inputs.uMaskCenter});
                float effMask = 1.0 - smoothstep(
                    ${inputs.uMaskRadius} * (1.0 - ${inputs.uMaskSoft}),
                    ${inputs.uMaskRadius},
                    effDist);
                float cutoff = mix(cutoffTime, effRadius * effMask, ${inputs.uMaskActive});
                // While held, suppress the reform tail so dissolved splats
                // stay "blown" instead of pre-fading toward home.
                rev = mix(rev, 0.0, ${inputs.uMaskActive});

                float edgeW  = max(${inputs.uEdgeWidth} * effRadius, 0.001);
                float burnt  = step(burn, cutoff);
                float onEdge = burnt * smoothstep(cutoff - edgeW, cutoff, burn);
                float gone   = burnt * (1.0 - onEdge);

                // ----- Flight trajectory: jitter + global wind direction -----
                vec3 jitter = normalize((rand3 - 0.5) * 2.0 + dir * 0.4 + vec3(0.0, 0.7, 0.0));
                vec3 flyDir = normalize(jitter + ${inputs.uWindDir} * 1.4);

                // Hero particles fly farther — controlled by uFlyMax
                float hero   = step(0.88, rand1);
                float flyMag = ${inputs.uIntensity}
                             * (0.6 + hero * (${inputs.uFlyMax} - 0.6) + rand2 * 0.8);

                float dissolveTime = clamp(
                  (cutoff - burn) / max(effRadius, 1e-4) - rand2 * 0.15, 0.0, 1.0);
                float traj = dissolveTime * (1.0 - rev * rev);

                vec3 fly = flyDir * flyMag * traj;
                // Constant wind drift on dissolved particles (streak push)
                fly += ${inputs.uWindDir} * traj * 0.6 * gone;
                // Subtle vertical wobble
                fly.y += sin(t * 2.0 + rand2 * 6.28) * 0.05 * traj;

                center += fly * gone;
                center += jitter * onEdge * 0.04 * ${inputs.uIntensity};

                // Per-splat colour is intentionally NOT modified — Dissolve
                // now acts purely as a positional explode/reform with no
                // tint or emissive overlay. (Originally tinted with uColor.)

                // ----- Alpha — wispy fbm gives smoke-like density variation
                float wispNoise01 = fbm(seed * 14.0 + vec3(t * 0.4, t * 0.6, 0.0));
                float wispMul     = mix(1.0, wispNoise01 * 1.6, ${inputs.uWispAmt} * gone);

                float alphaCurve = mix(1.0, 0.0, gone * (0.35 + dissolveTime * 0.65) * (1.0 - rev));
                rgba.a *= alphaCurve * wispMul;
                scales *= mix(1.0, 1.45, onEdge);
                scales *= mix(1.0, 0.55, gone * (1.0 - rev) * 0.85);
                // Optional colour tint on the burning edge — onEdge is the
                // edge-band intensity (peaks 1 right at the dissolve front,
                // 0 elsewhere) so the tint shows up exactly where the eye
                // is already drawn. uColor=(1,1,1) when colorOn is off, so
                // this collapses to identity in the default case.
                rgba.rgb *= mix(vec3(1.0), ${inputs.uColor}, onEdge * 0.85);

              } else if (${inputs.uEffect} == 3) {
                // ==============================================================
                // Effect 3 — Spiral Smear
                //
                // A focal point (uHit) holds the subject in place while splats
                // around it orbit and drift outward as iridescent ribbon trails.
                // Outer splats lag behind inner ones (angle ∝ dist) → the band
                // reads as a spiral. Wind direction biases the drift so the
                // whole thing tears off to one side like the painted-flower
                // reference. Per-splat seeded delay & hero factor break the
                // sheet into N independent ribbons.
                //
                // Reused knobs:
                //   uRadius     — outer reach of the swirl
                //   uSpeed      — base rotation speed
                //   uIntensity  — twist amount (angle accumulated per unit dist)
                //   uFlyMax     — trail length along uWindDir
                //   uEmissive   — iridescent rim brightness
                //   uColor      — base tint mixed under the rainbow shift
                // ==============================================================
                // ----- Localised band mask -------------------------------
                // The subject (close to uHit) stays sharp, the far field
                // stays untouched — only splats inside an annulus participate.
                float reach     = ${inputs.uRadius} * 1.6;
                float inner     = ${inputs.uRadius} * 0.50;
                float innerMask = smoothstep(inner * 0.4, inner, dist);  // 0 near hit
                float outerMask = smoothstep(reach, reach * 0.55, dist); // 0 past reach
                float bandMask  = innerMask * outerMask;
                // Roughen the band edge with fbm so it doesn't read as a perfect ring
                bandMask        = clamp(bandMask + (n - 0.5) * 0.35 * ${inputs.uEdgeRagged}, 0.0, 1.0);

                // ----- Directional bias: only the wind side smears -------
                float windLen   = length(${inputs.uWindDir});
                float windBias  = 1.0;
                if (windLen > 1e-3) {
                  float align   = dot(dir, ${inputs.uWindDir} / windLen);   // -1..1
                  windBias      = pow(max(align, 0.0), 0.7);                // 0..1, sharper on aligned side
                  windBias      = mix(0.10, 1.0, windBias);                 // keep a sliver everywhere
                }
                float fxMask    = bandMask * windBias;

                // ----- Per-splat noise variation -------------------------
                // Cellular noise groups nearby splats into "blobs" that share
                // a trail-length multiplier — some clusters fly far, others
                // barely move. Animated fbm adds an in-flight curl so each
                // ribbon wobbles independently instead of moving as a sheet.
                float cell      = cellular(seed * 0.55);                // 0..~1.4
                float cellNorm  = clamp(cell / 1.2, 0.0, 1.0);
                float curlA     = fbm(seed * 1.8 + vec3(${inputs.uTime} * 0.45, 0.0, 0.0)) - 0.5;
                float curlB     = fbm(seed * 1.8 + vec3(0.0, ${inputs.uTime} * 0.45, 5.7)) - 0.5;
                float curlC     = fbm(seed * 1.8 + vec3(2.3, 0.0, ${inputs.uTime} * 0.45)) - 0.5;
                vec3  curlVec   = vec3(curlA, curlB, curlC) * 2.0;       // -1..1 per axis

                // Per-splat staggered start → fans out into separate ribbons.
                float delay     = rand1 * 0.35;
                float a         = clamp((tNorm - delay) / max(1.0 - delay, 1e-4), 0.0, 1.0);
                float strength  = pow(a, 0.6) * (1.0 - pow(1.0 - a, 4.0));

                // Spiral angle: time-base + per-splat phase + radius twist
                // + curl perturbation so the orbit is non-uniform.
                float ang = ${inputs.uTime} * ${inputs.uSpeed} * 0.45
                          + dist * ${inputs.uIntensity} * 1.4
                          + rand2 * 0.6
                          + curlA * 1.8;
                float cs  = cos(ang * strength);
                float sn  = sin(ang * strength);
                // Rotate the splat offset around the world-up axis through uHit.
                vec3 r   = toHit;
                vec3 rRot = vec3(r.x * cs - r.z * sn, r.y, r.x * sn + r.z * cs);

                // Hero particles ride farther along the wind direction; cell
                // noise gives clustered "hero blobs" instead of random ones.
                float hero  = step(0.80, rand1);
                float cellBoost = mix(0.4, 1.6, cellNorm);               // 0.4..1.6
                float trail = ${inputs.uFlyMax}
                            * (0.20 + hero * 0.55 + rand2 * 0.30)
                            * cellBoost;
                vec3  drift = ${inputs.uWindDir} * dist * trail * 0.18 * strength;
                // Curl pushes the drift laterally so paths aren't straight.
                drift += curlVec * dist * 0.10 * strength;
                // Tiny vertical wobble for life
                drift.y += sin(${inputs.uTime} * 3.0 + rand2 * 6.28) * 0.04 * strength;

                // Mix between original offset and transformed offset by fxMask.
                // Splats outside the band keep their original world position.
                vec3 newOffset = mix(r, rRot + drift, fxMask);
                center = ${inputs.uHit} + newOffset;

                // ===== Mild streak via bounded scale change =================
                // Gaussian splats render via a covariance ellipsoid built from
                // (quaternion, scales). Setting scales to a large world-meter
                // value or rotating the quaternion away from the trained
                // covariance makes the gaussian "vanish" (the ellipsoid spans
                // so many pixels its per-pixel alpha drops below visible).
                //
                // So we keep the quaternion alone and clamp the scale change
                // to a SMALL multiplier of the splat's own size — the trail
                // illusion comes mostly from displacement, not from
                // anisotropic stretching.
                vec3 disp      = newOffset - r;
                float dispLen  = length(disp);
                float trailMix = fxMask * strength;

                vec3  srcScales = ${inputs.gsplat}.scales;
                float baseThick = max((srcScales.x + srcScales.y + srcScales.z) / 3.0, 1e-4);

                // Stretch factor 0..2 — translates "how far the splat moved"
                // into a bounded multiplier of its own size.
                float reachRef    = max(${inputs.uRadius}, 0.5);
                float stretchAmt  = clamp(dispLen / reachRef, 0.0, 1.0) * 2.0;
                // Lengthen one axis modestly, thin the others slightly.
                vec3  streakScales = srcScales * vec3(1.0 + stretchAmt, mix(1.0, 0.75, stretchAmt * 0.5), mix(1.0, 0.75, stretchAmt * 0.5));
                scales = mix(srcScales, streakScales, trailMix);

                // Tip of long streaks fades a little so trails feather out.
                rgba.a *= mix(1.0, 0.75, trailMix * 0.4);

                // Optional colour tint scaled by trailMix — the streak
                // direction shows up tinted, splats still at rest stay at
                // their source RGB. No-op when colorOn is off.
                rgba.rgb *= mix(vec3(1.0), ${inputs.uColor}, trailMix * 0.7);

              } else if (${inputs.uEffect} == 4) {
                // ==============================================================
                // Effect 4 — Vortex Drift  (3D port of Shadertoy XsjyRm
                // "Tons of Spatial-Sorted Particles")
                //
                // Each splat drifts along a 3D curl-noise flow field. The curl
                // of a vector noise potential is divergence-free so splats
                // orbit and shear without clumping — the dense, spatially
                // sorted swirling look from the reference. Localised around
                // uHit via a soft falloff mask; far splats stay fixed.
                //
                // Reused knobs:
                //   uRadius     — reach of the affected volume
                //   uNoiseScale — spatial scale of the flow field
                //   uSpeed      — animation speed of the flow
                //   uIntensity  — max displacement magnitude
                //   uWindDir    — bulk drift direction added on top of curl
                //   uEdgeRagged — noise-modulates the mask edge
                // ==============================================================

                // ----- Localisation mask (soft sphere around uHit) -------
                float reachVD = ${inputs.uRadius} * 1.8;
                float vMask   = 1.0 - smoothstep(reachVD * 0.55, reachVD, dist);
                vMask         = clamp(vMask + (n - 0.5) * 0.25 * ${inputs.uEdgeRagged}, 0.0, 1.0);

                // ----- 3D curl noise via finite-difference of vector noise ----
                // Sample vnoise at 3 offset positions to get 3 distinct scalar
                // potentials Px/Py/Pz, then take curl =
                //   (dPz/dy - dPy/dz, dPx/dz - dPz/dx, dPy/dx - dPx/dy).
                // Single-octave vnoise keeps cost ~12 hashes/splat; flow is
                // smoother and reads better as a particle field than fbm.
                float vdE   = 0.10;
                float vdT   = ${inputs.uTime} * ${inputs.uSpeed} * 0.22;
                vec3  vdP   = center * ${inputs.uNoiseScale} * 0.6
                            + ${inputs.uWindDir} * vdT * 0.4;

                vec3 vdOP1 = vdP + vec3(0.0,    0.0,    vdT);
                vec3 vdOP2 = vdP + vec3(31.41,  0.0,    vdT);
                vec3 vdOP3 = vdP + vec3(0.0,    47.13,  vdT);

                vec3 vdDX = vec3(vdE, 0.0, 0.0);
                vec3 vdDY = vec3(0.0, vdE, 0.0);
                vec3 vdDZ = vec3(0.0, 0.0, vdE);

                float vdGx = (vnoise(vdOP3 + vdDY) - vnoise(vdOP3 - vdDY))
                           - (vnoise(vdOP2 + vdDZ) - vnoise(vdOP2 - vdDZ));
                float vdGy = (vnoise(vdOP1 + vdDZ) - vnoise(vdOP1 - vdDZ))
                           - (vnoise(vdOP3 + vdDX) - vnoise(vdOP3 - vdDX));
                float vdGz = (vnoise(vdOP2 + vdDX) - vnoise(vdOP2 - vdDX))
                           - (vnoise(vdOP1 + vdDY) - vnoise(vdOP1 - vdDY));
                vec3 vdFlow = vec3(vdGx, vdGy, vdGz) / (2.0 * vdE);

                // Per-splat seeded phase so neighbouring splats don't lockstep.
                float vdPhase = 1.0 + 0.5 * sin(${inputs.uTime} * ${inputs.uSpeed} * 0.35 + rand1 * 6.2831);

                // Time envelope: ease-in across first 25%, then a GENTLE
                // ease-out across the last 55% so splats drift back to home
                // smoothly instead of snapping. The earlier 75-100% window
                // felt too quick — slow tail reads as natural settle.
                float vdEnv = smoothstep(0.0, 0.25, tNorm)
                            * (1.0 - smoothstep(0.45, 1.0, tNorm));

                vec3 vdDrift = vdFlow * ${inputs.uIntensity} * ${inputs.uRadius} * 0.45
                             * vMask * vdPhase * vdEnv;

                // Add a small bulk drift along uWindDir so the whole cloud
                // breathes in one direction (matches the "drift" feel of the
                // preset name without overriding the swirl).
                vdDrift += ${inputs.uWindDir} * ${inputs.uIntensity} * vMask * vdEnv * 0.18;

                center += vdDrift;

                // Subtle bloom: gaussians on the active flow get a touch
                // larger so dense regions read as bright "particles."
                scales *= mix(1.0, 1.18, vMask * vdEnv);
                // Mild alpha attenuation on the flowing parts so the swirling
                // mass doesn't oversaturate where streaks overlap.
                rgba.a *= mix(1.0, 0.85, vMask * vdEnv * 0.4);
                // Optional colour tint on the flowing splats (vMask*vdEnv
                // peaks where the vortex is active). No-op when colorOn off.
                rgba.rgb *= mix(vec3(1.0), ${inputs.uColor}, vMask * vdEnv * 0.7);

              } else if (${inputs.uEffect} == 5) {
                // ==============================================================
                // Effect 5 — Chaotic Particles  (port of Shadertoy
                //   "chaoticParticles" by stephenl7797, 2021)
                //
                // 3D Voronoi particle tracking: each splat finds its nearest
                // animated Voronoi cell center and is pulled toward it. As the
                // cell offsets drift over time, splats "jump" from one cell to
                // the next → chaotic clustering motion. The reference's
                // "depth blur" is approximated by blooming scale + alpha
                // proximally to cell centers (canonical Voronoi-edge metric
                // f2-f1 as the bloom inverse).
                //
                // Reused knobs:
                //   uRadius     — soft-mask reach around uHit
                //   uNoiseScale — Voronoi cell density (higher = smaller cells)
                //   uSpeed      — cell-offset drift rate
                //   uIntensity  — pull magnitude toward target cell
                //   uWindDir    — bulk direction the cell pattern flows in
                //   uEdgeRagged — mask-edge roughness
                // ==============================================================

                float cpReach = ${inputs.uRadius} * 1.8;
                float cpMask  = 1.0 - smoothstep(cpReach * 0.55, cpReach, dist);
                cpMask        = clamp(cpMask + (n - 0.5) * 0.22 * ${inputs.uEdgeRagged}, 0.0, 1.0);

                // Voronoi domain — multiplier dropped to 0.20 so cells are
                // LARGE relative to the scene (each cell encompasses many
                // thousands of splats). With small cells every splat picks a
                // different center → uncorrelated jitter; with big cells,
                // splats in the same region all pull toward the same target
                // → coherent group migration as the field drifts.
                float cpScale = max(${inputs.uNoiseScale} * 0.20, 0.02);
                float cpT     = ${inputs.uTime} * ${inputs.uSpeed} * 0.22;
                vec3  cpP     = (center - ${inputs.uHit}) * cpScale + ${inputs.uWindDir} * cpT;

                // Manual 27-cell Voronoi search — track BOTH the nearest cell
                // center (target to pull toward) AND the second-nearest
                // distance (for the f2-f1 edge metric used as bloom inverse).
                vec3  cpCi = floor(cpP);
                vec3  cpCf = fract(cpP);
                float cpD1 = 1e9;
                float cpD2 = 1e9;
                vec3  cpBest = vec3(0.0);
                for (int x = -1; x <= 1; x++) {
                  for (int y = -1; y <= 1; y++) {
                    for (int z = -1; z <= 1; z++) {
                      vec3 nb  = vec3(float(x), float(y), float(z));
                      // Animate the per-cell jitter so cell centers themselves
                      // drift — this is what makes splats "track" between cells.
                      vec3 hh  = hash33(cpCi + nb + vec3(cpT * 0.3, cpT * 0.21, 0.0));
                      vec3 cc  = cpCi + nb + hh;
                      vec3 dd  = cc - cpP;
                      float d2 = dot(dd, dd);
                      if (d2 < cpD1) { cpD2 = cpD1; cpD1 = d2; cpBest = cc; }
                      else if (d2 < cpD2) { cpD2 = d2; }
                    }
                  }
                }

                // Convert nearest cell center back to world coords:
                //   cpBest is in voronoi-domain space; invert the domain map.
                vec3 cpTarget = (cpBest - ${inputs.uWindDir} * cpT) / cpScale + ${inputs.uHit};
                vec3 cpPull   = cpTarget - center;

                // Time envelope: ease in/out across uDuration so the effect
                // blooms gracefully on a one-shot trigger.
                // Gentle ease-out: fall window widened to 50% so splats
                // unspool from their voxel-cluster targets without snapping.
                float cpEnv = smoothstep(0.0, 0.20, tNorm)
                            * (1.0 - smoothstep(0.50, 1.0, tNorm));

                // Pull magnitude — clamp the per-frame step so splats don't
                // teleport on huge cells; uIntensity caps the maximum.
                float cpPullMag = clamp(length(cpPull), 0.0, ${inputs.uIntensity} * 1.5);
                vec3  cpPullN   = length(cpPull) > 1e-5 ? cpPull / length(cpPull) : vec3(0.0);
                center += cpPullN * cpPullMag * 0.55 * cpMask * cpEnv;

                // Tiny per-splat seeded jitter — kept very low so the mass
                // still reads as one coherent flow rather than a noise cloud.
                vec3 cpJit = (rand3 - 0.5) * 2.0
                           * 0.005 * ${inputs.uIntensity} * cpMask * cpEnv;
                center += cpJit;

                // ---- Uniform bloom on all affected splats -----------------
                // The earlier per-splat f2-f1 bloom varied independently per
                // splat → flickery, non-cohesive look. Now the whole affected
                // mass blooms together based on mask×envelope only.
                scales *= mix(1.0, 1.45, cpMask * cpEnv);
                rgba.a *= mix(1.0, 0.85, cpMask * cpEnv * 0.5);
                // Optional colour tint scaled by the same mask×envelope —
                // tint pulses with the active particle motion. No-op off.
                rgba.rgb *= mix(vec3(1.0), ${inputs.uColor}, cpMask * cpEnv * 0.7);

              } else if (${inputs.uEffect} == 6) {
                // ==============================================================
                // Effect 6 — Slime Molds  (visual port of Shadertoy
                //   "My virtual slime molds" by michael0884, 2020)
                //
                // The original is an agent-based Physarum simulation (multi-
                // pass cellular automaton — particle positions in one buffer,
                // pheromone trail map in another, ping-pong each frame). That
                // can't run in a stateless per-frame splat shader, so we
                // approximate the LOOK instead: a domain-warped ridge-noise
                // "trail field" that has thin vein-like features, with each
                // splat pulled along the local gradient toward high-vein
                // regions. As the field drifts in time, splats migrate
                // between veins → similar organic branching aesthetic.
                //
                // Knobs:
                //   uRadius     — soft mask reach around uHit
                //   uNoiseScale — vein density (higher = thinner veins)
                //   uSpeed      — vein-field drift rate
                //   uIntensity  — pull strength toward veins
                //   uWindDir    — direction the trail field flows in
                // ==============================================================

                float smReach = ${inputs.uRadius} * 1.8;
                float smMask  = 1.0 - smoothstep(smReach * 0.55, smReach, dist);
                smMask        = clamp(smMask + (n - 0.5) * 0.2 * ${inputs.uEdgeRagged}, 0.0, 1.0);

                float smScale = max(${inputs.uNoiseScale} * 1.2, 0.05);
                float smT     = ${inputs.uTime} * ${inputs.uSpeed} * 0.18;
                vec3  smP     = (center - ${inputs.uHit}) * smScale + ${inputs.uWindDir} * smT;

                // Trail field: domain-warp vnoise so streams meander, then
                // ridge-fold (1 - |2v - 1|) to turn smooth noise into thin
                // bright veins separated by dark gaps — the slime-trail shape.
                // Wrapped in a macro-style local lambda would be cleaner but
                // GLSL doesn't allow that, so we inline the helper here.
                vec3 smW = vec3(
                  vnoise(smP + vec3(0.0, 0.0, smT)),
                  vnoise(smP + vec3(5.31, 7.13, smT * 0.7)),
                  vnoise(smP + vec3(11.7, 3.27, smT * 1.1))
                ) - 0.5;
                vec3 smQ = smP + smW * 0.55;

                float smE  = 0.10;
                float smV  = 1.0 - abs(2.0 * vnoise(smQ) - 1.0);
                float smVx = 1.0 - abs(2.0 * vnoise(smQ + vec3(smE, 0.0, 0.0)) - 1.0);
                float smVy = 1.0 - abs(2.0 * vnoise(smQ + vec3(0.0, smE, 0.0)) - 1.0);
                float smVz = 1.0 - abs(2.0 * vnoise(smQ + vec3(0.0, 0.0, smE)) - 1.0);
                vec3  smGrad = vec3(smVx - smV, smVy - smV, smVz - smV) / smE;

                // Pull TOWARD high-vein values (gradient points up the ridge).
                // Magnitude bounded so splats don't shoot off on noisy frames.
                // Gentle ease-out: long 50% tail so the slime trail releases
                // its grip on veins gradually as the FX winds down.
                float smEnv = smoothstep(0.0, 0.20, tNorm)
                            * (1.0 - smoothstep(0.50, 1.0, tNorm));

                vec3 smPull = smGrad * (${inputs.uIntensity} * 0.30 / smScale)
                             * smMask * smEnv;
                // Clamp per-splat step magnitude so spikes don't blow up.
                float smPullMag = min(length(smPull), ${inputs.uIntensity} * 0.8);
                vec3  smPullN   = length(smPull) > 1e-5 ? smPull / length(smPull) : vec3(0.0);
                center += smPullN * smPullMag;

                // Per-splat seeded jitter so the trail isn't a uniform sheet.
                center += (rand3 - 0.5) * 2.0 * 0.018 * ${inputs.uIntensity} * smMask * smEnv;
                // Positional movement only — no scale or alpha overlays.
                // (Removed the vein-bloom scale/alpha mods that previously
                // tinted the background; per user request, Slime Molds is
                // now strictly a displacement effect.)
                // Optional opt-in colour tint on the moving veins. No-op
                // when colorOn is off so the displacement-only intent is
                // preserved by default.
                rgba.rgb *= mix(vec3(1.0), ${inputs.uColor}, smMask * smEnv * 0.6);

              } else if (${inputs.uEffect} == 7) {
                // ==============================================================
                // Effect 7 — Feather Roots  (visual port of Shadertoy
                //   "Feather roots" by michael0884, 2020)
                //
                // The reference is multi-pass CA particles advecting through
                // mouse-spawned vortices. We approximate the LOOK: splats
                // stream OUTWARD from uHit along noise-perturbed radial
                // directions. Because the noise is smooth across nearby
                // splats, adjacent splats follow similar paths → visible
                // branching fibers form (the "roots" / "feather barbs"
                // character). Per-splat speed variance creates the bright
                // tips and trailing trunks. The earlier version sucked
                // splats INTO uHit — "dug a hole" — fixed by reversing the
                // radial direction and adding a no-go zone around uHit so
                // the spawn point itself stays intact.
                //
                // Knobs:
                //   uRadius     — outer reach of the spreading volume
                //   uSpeed      — base outward streaming rate
                //   uIntensity  — push magnitude
                //   uNoiseScale — branch frequency (higher = finer fibers)
                //   uFlyMax     — branch divergence (how much noise tilts
                //                 the radial direction; higher = more wild)
                //   uWindDir    — bulk bias direction layered on top
                // ==============================================================

                vec3  frTo     = center - ${inputs.uHit};
                float frR      = length(frTo);
                vec3  frRadial = frR > 1e-5 ? frTo / frR : vec3(0.0, 1.0, 0.0);

                // Soft reach mask + inner no-go zone so the spawn point
                // doesn't void out. Splats inside frInner stay put — the
                // "seed" of the root system.
                float frReach  = ${inputs.uRadius} * 2.0;
                float frInner  = ${inputs.uRadius} * 0.15;
                float frOuter  = 1.0 - smoothstep(frReach * 0.5, frReach, frR);
                float frInside = smoothstep(0.0, frInner, frR);
                float frMask   = clamp(frOuter * frInside, 0.0, 1.0);
                frMask         = clamp(frMask + (n - 0.5) * 0.2 * ${inputs.uEdgeRagged}, 0.0, 1.0);

                // Branch direction: radial outward, perturbed by a smooth
                // noise field. Adjacent splats sample similar noise →
                // they follow similar paths → branches form.
                vec3 frNoiseP = center * ${inputs.uNoiseScale} * 0.7
                              + vec3(${inputs.uTime} * 0.25, 0.0, 0.0);
                vec3 frPerturb = vec3(
                  vnoise(frNoiseP + vec3(0.0,   0.0,   0.0)),
                  vnoise(frNoiseP + vec3(5.31,  7.13,  0.0)),
                  vnoise(frNoiseP + vec3(11.7,  3.27,  0.0))
                ) - 0.5;
                vec3 frBranchDir = normalize(
                  frRadial + frPerturb * ${inputs.uFlyMax} * 0.45
                  + ${inputs.uWindDir} * 0.15);

                // Per-splat radial-speed modulation creates the feather
                // gradient: some splats race to the tip, others trail.
                float frFeath = vnoise(center * ${inputs.uNoiseScale} * 1.5
                                     + vec3(0.0, ${inputs.uTime} * 0.45, 0.0));
                // Radial-phase shell so the eye can see "waves" of growth
                // propagating outward instead of a static cloud.
                float frShell = sin(frR * 1.5 - ${inputs.uTime} * ${inputs.uSpeed} * 0.5);

                // Gentle ease-out: long 52% tail so branches collapse back
                // into the seed point without an abrupt snap.
                float frEnv = smoothstep(0.0, 0.18, tNorm)
                            * (1.0 - smoothstep(0.48, 1.0, tNorm));

                float frSpeed = ${inputs.uSpeed} * 0.28
                              * (0.30 + 1.5 * frFeath)
                              * (0.65 + 0.35 * frShell);

                // OUTWARD push (no inward suction — fixes the "hole" bug).
                vec3 frPush = frBranchDir * ${inputs.uIntensity} * frSpeed
                            * frMask * frEnv * 0.55;
                center += frPush;

                // Streak via scale: slight elongation along the splat's
                // local first axis (covariance-safe — see Spiral Smear).
                vec3  frSrcSc   = ${inputs.gsplat}.scales;
                float frStretch = clamp(length(frPush) * 7.0, 0.0, 1.5);
                scales = mix(frSrcSc,
                             frSrcSc * vec3(1.0 + frStretch,
                                            mix(1.0, 0.7, frStretch * 0.4),
                                            mix(1.0, 0.7, frStretch * 0.4)),
                             frMask * frEnv);

                // Bloom on the active mass + tip alpha softening so
                // branches feather out into the surrounding scene.
                scales *= mix(1.0, 1.18, frMask * frEnv);
                float frTipFade = smoothstep(frReach * 0.55, frReach, frR);
                rgba.a *= mix(1.0, 0.7, frTipFade * frMask * frEnv);
                // Optional colour tint on the streaking splats — frMask*frEnv
                // is the active-region factor. No-op when colorOn is off.
                rgba.rgb *= mix(vec3(1.0), ${inputs.uColor}, frMask * frEnv * 0.7);

              } else {
                // ==============================================================
                // Effect 2 — Scan Line  (double ring, noise breakup, afterglow)
                // ==============================================================
                float reach    = ${inputs.uRadius};
                float waveFront= t * ${inputs.uSpeed};

                // Noise breaks the ring up — splats slightly ahead/behind the front
                float effDist  = dist + nSigned * reach * 0.10;

                float lineW    = max(reach * 0.06, 0.04);
                float ringA    = pulse(effDist, waveFront,             lineW);            // primary
                float ringB    = pulse(effDist, waveFront - lineW*2.5, lineW * 0.7) * 0.6;// trailing
                float ring     = ringA + ringB;

                // Afterglow — splats behind the front retain a fading tint
                float behind   = smoothstep(waveFront, waveFront - reach * 0.9, effDist);
                float afterGlow= behind * life * 0.45;

                float reachMsk = smoothstep(reach * 1.3, 0.0, dist);
                float scan     = ring * reachMsk;

                // Position pop on the ring; very small
                vec3 jitter  = (rand3 - 0.5) * 2.0;
                center += dir    * scan * ${inputs.uIntensity} * 0.18;
                center += jitter * scan * ${inputs.uIntensity} * 0.10;

                // Emissive ring with hot-white core
                vec3 hot = mix(${inputs.uColor}, vec3(1.0), 0.6);
                rgba.rgb = mix(rgba.rgb, ${inputs.uColor}, clamp(afterGlow + scan * 0.4, 0.0, 0.95));
                rgba.rgb += hot * scan * ${inputs.uEmissive};

                // Ring splats puff briefly
                scales *= 1.0 + scan * 0.5;
              }

              ${outputs.gsplat}.center = center;
              ${outputs.gsplat}.scales = scales;
              ${outputs.gsplat}.rgba   = rgba;
            }

            // ================================================================
            // Soft fade-out gate — smooth blend between the original splat
            // and whatever the effect produced. Lets the controller ramp
            // strength 1→0 over a tail period instead of snapping off.
            // ================================================================
            {
              float s = clamp(${inputs.uEffectStrength}, 0.0, 1.0);
              ${outputs.gsplat}.center = mix(${inputs.gsplat}.center, ${outputs.gsplat}.center, s);
              ${outputs.gsplat}.scales = mix(${inputs.gsplat}.scales, ${outputs.gsplat}.scales, s);
              ${outputs.gsplat}.rgba   = mix(${inputs.gsplat}.rgba,   ${outputs.gsplat}.rgba,   s);
            }

            // ================================================================
            // Splat sub-form + layer visibility.
            //
            //   uSplatSubform = 0 → Gaussian (leave scales unchanged)
            //                 = 1 → Point    (collapse scales to uPointSize)
            //   uSplatVis     → multiplies final splat alpha (0 = invisible)
            //
            // Mask reveal (palm): inside the mask region, sub-form is
            // inverted — i.e. a "hole" of Gaussians in a Point-form scene
            // or vice-versa.
            // ================================================================
            float maskMix = 0.0;
            float soft = max(${inputs.uMaskSoft}, 0.001);
            if (${inputs.uMaskActive} > 0.5) {
              vec3 d = ${outputs.gsplat}.center - ${inputs.uMaskCenter};
              float mDist = (${inputs.uMaskShape} == 1)
                ? max(abs(d.x), max(abs(d.y), abs(d.z)))
                : length(d);
              float r0 = ${inputs.uMaskRadius} * (1.0 - soft);
              float r1 = ${inputs.uMaskRadius};
              maskMix = 1.0 - smoothstep(r0, r1, mDist);
            }

            // Effective sub-form per splat: invert inside the mask.
            //   Gaussian (0) inverted → Point (1), and vice-versa.
            //   Smooth blend: subform value in [0, 1] for soft mask edges.
            float baseSubform = clamp(${inputs.uSplatSubform}, 0.0, 1.0);
            float effSubform  = mix(baseSubform, 1.0 - baseSubform, maskMix);

            // Apply Point shrink proportional to effSubform
            if (effSubform > 0.001) {
              vec3 dotScale = vec3(${inputs.uPointSize});
              ${outputs.gsplat}.scales =
                mix(${outputs.gsplat}.scales, dotScale, effSubform);
              // Boost alpha so the dots stay legible against the dark background
              vec4 rr = ${outputs.gsplat}.rgba;
              rr.a = mix(rr.a, max(rr.a, 0.92), effSubform);
              ${outputs.gsplat}.rgba = rr;
            }

            // Layer visibility — gate the whole splat layer.
            ${outputs.gsplat}.rgba.a *= clamp(${inputs.uSplatVis}, 0.0, 1.0);
          `),
      });

      return {
        gsplat: shader.apply({
          gsplat,
          uTime:       uniforms.time,
          uHit:        uniforms.hit,
          uColor:      uniforms.color,
          uRadius:     uniforms.radius,
          uSpeed:      uniforms.speed,
          uIntensity:  uniforms.intensity,
          uEffect:     uniforms.effect,
          uActive:     uniforms.active,
          uDuration:   uniforms.duration,
          uNoiseScale: uniforms.noiseScale,
          uEdgeWidth:  uniforms.edgeWidth,
          uEmissive:   uniforms.emissive,
          uSplatSubform: uniforms.splatSubform,
          uSplatVis:     uniforms.splatVis,
          uPointSize:    uniforms.pointSize,
          uEffectStrength: uniforms.effectStrength,
          uMaskActive: uniforms.maskActive,
          uMaskCenter: uniforms.maskCenter,
          uMaskRadius: uniforms.maskRadius,
          uMaskShape:  uniforms.maskShape,
          uMaskSoft:   uniforms.maskSoft,
          uWindDir:    uniforms.windDir,
          uEdgeRagged: uniforms.edgeRagged,
          uWispAmt:    uniforms.wispAmt,
          uFlyMax:     uniforms.flyMax,
        }).gsplat,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
export class EffectController {
  constructor(splatMesh) {
    this.mesh = splatMesh;
    this.timeCounter = 0;
    this.activeTimer = 0;
    this.continuous   = false;
    this.targetHit    = new THREE.Vector3();
    this.smoothedHit  = new THREE.Vector3();
    this.hitSeeded    = false;
    this.hitLerpRate  = 14;

    // Layer visibility animation: each layer's uniform value lerps toward
    // its target (driven by checkbox toggle in the GUI). 1/s — frame-rate
    // independent via exp-decay in update().
    this.visTransitionRate = 1.2;
    this.targetVis = {
      splat: params.splatLayer ? 1.0 : 0.0,
      quad:  params.quadLayer  ? 1.0 : 0.0,
      voxel: params.voxelLayer ? 1.0 : 0.0,
    };

    // Gaussian ↔ Point sub-form lerp. Toggling sets targetSubform to 0 or 1;
    // update() exp-decays the uniform toward it for a smooth shape morph.
    this.targetSubform     = SUBFORM_INDEX[params.splatSubform] ?? 0;
    this.subformLerpRate   = 1.2;
    uniforms.splatSubform.value = this.targetSubform;
    // Seed uniforms to match targets so we don't fade in unnecessarily on load.
    uniforms.splatVis.value = this.targetVis.splat;
    uniforms.quadVis.value  = this.targetVis.quad;
    uniforms.voxelVis.value = this.targetVis.voxel;

    this.fadeTailS = params.fadeTail;
    this.applyParams();
  }
  applyParams() {
    uniforms.effect.value     = EFFECT_INDEX[params.effect] ?? 0;
    uniforms.radius.value     = params.radius;
    uniforms.speed.value      = params.speed;
    uniforms.intensity.value  = params.intensity;
    uniforms.duration.value   = params.duration;
    uniforms.noiseScale.value = params.noiseScale;
    uniforms.edgeWidth.value  = params.edgeWidth;
    uniforms.emissive.value   = params.emissive;
    // Just retarget; the per-frame lerp in update() handles the morph.
    this.targetSubform = SUBFORM_INDEX[params.splatSubform] ?? 0;
    uniforms.pointSize.value  = params.pointSize;
    // Mirror size values into uniforms so downstream consumers (Voxelizer /
    // Quadizer construction) have a single source of truth.
    uniforms.quadSize.value   = params.quadSize;
    uniforms.voxelSize.value  = params.voxelSize;
    uniforms.maskShape.value  = MASK_SHAPE_INDEX[params.maskShape] ?? 0;
    uniforms.maskRadius.value = params.maskRadius;
    uniforms.maskSoft.value   = params.maskSoft;
    uniforms.windDir.value.set(params.windX, params.windY, params.windZ);
    uniforms.edgeRagged.value = params.edgeRagged;
    uniforms.wispAmt.value    = params.wispAmt;
    uniforms.flyMax.value     = params.flyMax;
    // Honour the Color tint toggle — off (default) forces neutral
    // white so Scan Line and any future color-aware effect render
    // monochrome regardless of what's parked in the colour picker.
    // The picker value only takes effect when the user explicitly
    // opts in via the Color tint checkbox in the FX → Core folder.
    if (params.colorOn) {
      const c = new THREE.Color(params.color);
      uniforms.color.value.set(c.r, c.g, c.b);
    } else {
      uniforms.color.value.set(1, 1, 1);
    }
    this.mesh?.updateVersion();
  }

  // Layer visibility — animate via the rAF loop. layer: "splat"|"quad"|"voxel".
  setLayerVis(layer, on) {
    if (!(layer in this.targetVis)) return;
    this.targetVis[layer] = on ? 1.0 : 0.0;
  }

  // Move the reveal mask to a new object-space center; pass null/undefined to disable.
  setMaskCenter(localPoint) {
    if (localPoint) {
      uniforms.maskCenter.value.copy(localPoint);
      uniforms.maskActive.value = 1.0;
    } else {
      uniforms.maskActive.value = 0.0;
    }
    this.mesh?.updateVersion();
  }

  // Discrete one-shot (used by mouse click)
  triggerAt(localPoint) {
    uniforms.hit.value.copy(localPoint);
    uniforms.active.value = 1.0;
    uniforms.effectStrength.value = 1.0;
    this.timeCounter = 0.0;
    this.activeTimer = params.duration + this.fadeTailS;
    this.continuous = false;
  }
  // Continuous "brush" — call as often as you have a hit (raycast result).
  // Updates targetHit only; the smoothing + time loop happen in update().
  brushAt(localPoint) {
    this.targetHit.copy(localPoint);
    if (!this.hitSeeded || !this.continuous) {
      this.smoothedHit.copy(localPoint);
      uniforms.hit.value.copy(localPoint);
      this.hitSeeded = true;
    }
    uniforms.active.value = 1.0;
    uniforms.effectStrength.value = 1.0;
    this.continuous = true;
  }
  // Source went away — enter the tail fade (smooth 1→0) instead of cutting
  releaseBrush() {
    if (!this.continuous) return;
    this.continuous = false;
    this.activeTimer = this.fadeTailS;
  }
  update(dt) {
    // ---- Animate layer visibility (independent of FX state) -------------
    {
      let dirty = false;
      const layers = [
        ["splat", uniforms.splatVis],
        ["quad",  uniforms.quadVis],
        ["voxel", uniforms.voxelVis],
      ];
      const k = 1 - Math.exp(-this.visTransitionRate * dt);
      for (const [name, u] of layers) {
        const target = this.targetVis[name];
        if (Math.abs(u.value - target) > 1e-4) {
          u.value += (target - u.value) * k;
          dirty = true;
        }
      }
      if (dirty) this.mesh.updateVersion();
    }

    // ---- Gaussian ↔ Point sub-form lerp (independent of FX state) -------
    {
      const u = uniforms.splatSubform;
      if (Math.abs(u.value - this.targetSubform) > 1e-4) {
        const k = 1 - Math.exp(-this.subformLerpRate * dt);
        u.value += (this.targetSubform - u.value) * k;
        this.mesh?.updateVersion();
      }
    }

    if (uniforms.active.value < 0.5) return;
    this.timeCounter += dt;

    if (this.continuous) {
      // Smooth hit toward latest target — kills jitter from discrete raycast updates
      const k = 1 - Math.exp(-this.hitLerpRate * dt);
      this.smoothedHit.lerp(this.targetHit, k);
      uniforms.hit.value.copy(this.smoothedHit);

      const dur = Math.max(uniforms.duration.value, 0.1);
      if (this.timeCounter >= dur) this.timeCounter -= dur; // loop
      uniforms.time.value = this.timeCounter;
      uniforms.effectStrength.value = 1.0;
    } else {
      // One-shot / brush-release tail. We let `time` keep advancing so the
      // animation continues to play out, but we ramp `effectStrength` 1→0
      // during the last fadeTailS seconds so splats blend back smoothly.
      this.activeTimer -= dt;
      uniforms.time.value = this.timeCounter;

      const tail = this.fadeTailS;
      if (this.activeTimer < tail && tail > 1e-4) {
        const tNorm = Math.max(0, this.activeTimer / tail);     // 1 → 0 over tail
        // smoothstep curve for a creamy ease-out
        uniforms.effectStrength.value = tNorm * tNorm * (3.0 - 2.0 * tNorm);
      } else {
        uniforms.effectStrength.value = 1.0;
      }

      if (this.activeTimer <= 0.0) {
        uniforms.active.value         = 0.0;
        uniforms.effectStrength.value = 0.0;
        uniforms.time.value           = 0.0;
        this.hitSeeded                = false;
      }
    }
    this.mesh.updateVersion();
  }
}

// ---------------------------------------------------------------------------
// GUI — grouped for the FX-style param surface
// ---------------------------------------------------------------------------
const PRESETS = {
  "Cyan Plasma":    { effect: "Wave & Tint",        color: "#00e0ff", radius: 2.5, speed: 6.0, intensity: 0.7, duration: 2.2, noiseScale: 1.0, edgeWidth: 0.18, emissive: 2.5, edgeRagged: 0.4, wispAmt: 0.5, flyMax: 2.0, windX: 0,    windY: 0,   windZ: 0 },
  "Magenta Burn":   { effect: "Dissolve & Reform",  color: "#ff3aa9", radius: 2.0, speed: 4.0, intensity: 1.0, duration: 3.2, noiseScale: 0.8, edgeWidth: 0.22, emissive: 3.5, edgeRagged: 0.7, wispAmt: 0.7, flyMax: 3.5, windX: 0,    windY: 0,   windZ: 0 },
  "Hot Embers":     { effect: "Dissolve & Reform",  color: "#ff8a1a", radius: 2.5, speed: 4.0, intensity: 1.4, duration: 3.8, noiseScale: 1.4, edgeWidth: 0.30, emissive: 4.0, edgeRagged: 0.9, wispAmt: 0.9, flyMax: 5.0, windX: 0,    windY: 0.3, windZ: 0 },
  "Hair Spray":     { effect: "Dissolve & Reform",  color: "#f4d3c8", radius: 1.6, speed: 4.0, intensity: 1.5, duration: 4.5, noiseScale: 1.6, edgeWidth: 0.35, emissive: 1.8, edgeRagged: 1.1, wispAmt: 1.2, flyMax: 6.0, windX: -0.9, windY: 0.4, windZ: 0 },
  "Tron Sweep":     { effect: "Scan Line",          color: "#7ef0ff", radius: 3.5, speed: 7.0, intensity: 0.6, duration: 2.0, noiseScale: 0.6, edgeWidth: 0.10, emissive: 3.2, edgeRagged: 0.3, wispAmt: 0.2, flyMax: 2.0, windX: 0,    windY: 0,   windZ: 0 },
  "Toxic Pulse":    { effect: "Wave & Tint",        color: "#9eff3a", radius: 3.0, speed: 8.0, intensity: 0.5, duration: 1.8, noiseScale: 1.2, edgeWidth: 0.15, emissive: 3.0, edgeRagged: 0.4, wispAmt: 0.4, flyMax: 2.0, windX: 0,    windY: 0,   windZ: 0 },
  "Iris Spiral":    { effect: "Spiral Smear",       color: "#ff7fc8", radius: 3.0, speed: 5.0, intensity: 1.4, duration: 3.6, noiseScale: 1.0, edgeWidth: 0.18, emissive: 2.8, edgeRagged: 0.5, wispAmt: 0.7, flyMax: 4.0, windX: 1.0,  windY: 0,   windZ: 0 },
  "Vortex Drift":   { effect: "Vortex Drift",       color: "#9dd8ff", radius: 4.0, speed: 3.5, intensity: 0.37, duration: 4.5, noiseScale: 1.0, edgeWidth: 0.18, emissive: 2.0, edgeRagged: 0.5, wispAmt: 0.6, flyMax: 6.0, windX: 0.6,  windY: 0.2, windZ: -0.4, fadeTail: 1.1 },
  "Chaotic Particles": { effect: "Chaotic Particles", color: "#c0a8ff", radius: 3.5, speed: 4.0, intensity: 1.6, duration: 5.0, noiseScale: 1.8, edgeWidth: 0.18, emissive: 2.2, edgeRagged: 0.6, wispAmt: 0.5, flyMax: 4.0, windX: 0.3,  windY: 0.0, windZ: 0.2 },
  "Slime Molds":       { effect: "Slime Molds",       color: "#d4ff7a", radius: 0.95, speed: 3.0, intensity: 1.6, duration: 6.0, noiseScale: 2.2, edgeWidth: 0.18, emissive: 1.8, edgeRagged: 0.5, wispAmt: 0.7, flyMax: 3.0, windX: 0.4,  windY: 0.0, windZ: 0.3 },
  "Feather Roots":     { effect: "Feather Roots",     color: "#d4ff7a", radius: 5.4, speed: 5.0, intensity: 1.6, duration: 6.0, noiseScale: 1.6, edgeWidth: 0.18, emissive: 2.0, edgeRagged: 0.4, wispAmt: 0.5, flyMax: 2.0, windX: 0.0,  windY: 1.0, windZ: 0.0 },
};

export function buildGUI(controller) {
  const gui = new GUI({ title: "SplatGarden Studio" });

  const presetKeys = Object.keys(PRESETS);
  // Default the FX dropdown to Slime Molds and seed params with its values
  // so the GUI controllers display Slime Molds' knobs on first render
  // (without this, params would still reflect the bare module-level defaults
  // and the dropdown label would mismatch the visible knob values).
  const DEFAULT_PRESET = "Slime Molds";
  const presetObj = { preset: DEFAULT_PRESET };
  if (PRESETS[DEFAULT_PRESET]) {
    Object.assign(params, PRESETS[DEFAULT_PRESET]);
    controller.applyParams();
  }

  // ----- Top-level: 3DGS / USD (formerly "Layers") -------------------------
  // Kept OUT of Customize so the data-source / instancer choices are visually
  // distinct from styling controls.
  const fLayers = gui.addFolder("3DGS/USD");

  // ----- Top-level: FX (promoted from Customize → Play → FX) ---------------
  // The Effect chooser + Color/Radius/Duration/Intensity are the headline
  // interaction surface of the app — the whole "click to scan" experience.
  // The old 4-level burial (Customize → Play → FX → Core) hid this
  // discoverability cost: visitors had to drill twice before they could play.
  // Promoting FX to top-level cuts that to one click, matching how often
  // the user actually wants to reach for it.
  const fFX = gui.addFolder("FX");

  // ----- Top-level: Performance — Battery / Balanced / Max Quality ---------
  // Single dial driving pixel-ratio cap, bloom default, particles default.
  // Persisted to localStorage so a battery-conscious user only has to set
  // it once. The actual perf-side switching (dpr, bloom toggle, particles
  // toggle) is wired in main.js — here we just expose the chooser and
  // persist the user's pick.
  const PERF_LABEL = "Performance";
  const PERF_OPTIONS = { Battery: "battery", Balanced: "balanced", "Max Quality": "max" };
  let _currentPerf = "balanced";
  try { _currentPerf = localStorage.getItem("splatgarden:perf") || "balanced"; } catch {}
  if (!(_currentPerf in { battery:1, balanced:1, max:1 })) _currentPerf = "balanced";
  const perfObj = { perf: _currentPerf };
  const perfCtrl = gui.add(perfObj, "perf", PERF_OPTIONS).name(PERF_LABEL).onChange(v => {
    try { localStorage.setItem("splatgarden:perf", v); } catch {}
    // Most settings are applied at init from the persisted value — a
    // change at runtime needs a reload to fully re-apply (DPR + bloom +
    // particles default all branch off the profile during boot). Surface
    // a status hint so the user knows what to do.
    if (typeof window.__perfStatus === "function") window.__perfStatus(v);
  });
  perfCtrl.domElement.title = "Battery saves power · Max Quality enables bloom + particles. Reload to fully apply.";

  // ----- Top-level: Customize → everything visual --------------------------
  const fCustomize = gui.addFolder("Customize");

  // Preset switching with a smooth 500 ms blend on numeric params.
  // Non-numeric / non-lerpable fields (effect, colorOn, color) snap at
  // the start so the right shader branch + tint colour are active for
  // the whole transition; numeric params (radius, speed, intensity,
  // duration, noiseScale, edgeWidth, emissive, edgeRagged, wispAmt,
  // flyMax, windX/Y/Z) ease-in-out from current → target. A pending
  // lerp is cancelled if the user picks another preset mid-flight so
  // a rapid sequence of clicks settles on the final selection rather
  // than blending through every intermediate. GUI controllers update
  // once at the start (snap) and once at the end (final values) to
  // avoid jittery per-frame display thrashing.
  let _presetLerpRAF = null;
  function lerpToPreset(targetName) {
    const target = PRESETS[targetName];
    if (!target) return;
    if (_presetLerpRAF) {
      cancelAnimationFrame(_presetLerpRAF);
      _presetLerpRAF = null;
    }
    const duration = 500;
    const startTime = performance.now();
    const startVals  = {};
    const targetVals = {};
    for (const key in target) {
      if (typeof target[key] === "number") {
        startVals[key]  = params[key];
        targetVals[key] = target[key];
      } else {
        // Snap non-numeric values (effect, color, colorOn) immediately
        // so the shader branch + tint colour are correct during the lerp.
        params[key] = target[key];
      }
    }
    // First applyParams flushes the snapped non-numeric values into the
    // shader; the per-frame applyParams calls below then drive the
    // numeric lerp.
    controller.applyParams();
    // Refresh GUI once now so the preset's non-numeric controllers
    // (Effect dropdown, Color picker, Color tint checkbox) reflect the
    // new state immediately.
    gui.controllersRecursive().forEach((c) => c.updateDisplay());

    const step = (now) => {
      const t = Math.min(1, (now - startTime) / duration);
      // Smooth ease-in-out (cubic).
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      for (const key in targetVals) {
        params[key] = startVals[key] + (targetVals[key] - startVals[key]) * eased;
      }
      controller.applyParams();
      if (t < 1) {
        _presetLerpRAF = requestAnimationFrame(step);
      } else {
        _presetLerpRAF = null;
        // Final controller refresh — settles the numeric sliders on
        // their target values after the per-frame lerp has been
        // sweeping them silently.
        gui.controllersRecursive().forEach((c) => c.updateDisplay());
      }
    };
    _presetLerpRAF = requestAnimationFrame(step);
  }

  fFX.add(presetObj, "preset", presetKeys).name("Preset").onChange((name) => {
    lerpToPreset(name);
    // Surface the preset name as a micro-toast so a change from a deep
    // panel still reads as a deliberate state shift.
    window.__toast?.(`Preset: ${name}`);
  });

  const fCore = fFX.addFolder("Core");
  fCore.add(params, "effect", Object.keys(EFFECT_INDEX)).name("Effect").onChange(() => controller.applyParams());
  // Color tint — opt-in checkbox guarding the picker below. Off by
  // default so the FX section reads monochrome on first open, matching
  // the project's monochrome aesthetic; toggling on reveals the picker
  // and pipes its value through to the shader uniform.
  // `let colorPicker` (not const) so the checkbox's onChange closure
  // can reference it before the picker is registered on the line
  // below — the closure only fires later when the user clicks, by
  // which time the picker has been initialised.
  let colorPicker;
  // Slider-range expander. lil-gui's number controller clamps typed
  // values to its [min, max] window; this helper lets the user TYPE
  // a value beyond the cap and have the window expand to fit instead.
  // Reads the input element from the controller, listens on the
  // capture phase so we run BEFORE lil-gui's own change handler, and
  // calls controller.max() / .min() to expand the range before the
  // subsequent clamping setValue runs. Use it on any FX slider where
  // a power-user might legitimately want a value outside the default
  // range — e.g., radius up to 50 for huge ripples, duration up to 30
  // for slow-burn effects.
  //
  // Side benefit: the slider track redraws with the new max so a
  // value of 50 doesn't sit invisibly off the right edge.
  function allowExpand(controller) {
    if (!controller) return controller;
    const input = controller.$input
               ?? controller.domElement?.querySelector?.("input[type='number']")
               ?? controller.domElement?.querySelector?.("input");
    if (!input) return controller;
    // Title hint surfaces the affordance without adding a UI element.
    const orig = input.title || "";
    input.title = orig ? `${orig} · Type a value beyond the max to extend the range.`
                       : "Type a value beyond the max to extend the range.";
    input.addEventListener("change", () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v)) return;
      if (typeof controller._max === "number" && v > controller._max) {
        controller.max(v);
      }
      if (typeof controller._min === "number" && v < controller._min) {
        controller.min(v);
      }
    }, true);
    return controller;
  }

  fCore.add(params, "colorOn").name("Color tint").onChange((on) => {
    if (on) colorPicker.show(); else colorPicker.hide();
    controller.applyParams();
    // Tiny toast so the on/off flip feels acknowledged. window.__toast
    // is defined in main.js after the boot helpers section; check before
    // calling so HMR / standalone use of this module doesn't crash.
    window.__toast?.(on ? "Color tint on" : "Color tint off");
  });
  colorPicker = fCore.addColor(params, "color").name("Color").onChange(() => controller.applyParams());
  if (!params.colorOn) colorPicker.hide();
  allowExpand(fCore.add(params, "radius",    0.1, 10.0, 0.05).name("Radius").onChange(() => controller.applyParams()));
  allowExpand(fCore.add(params, "duration",  0.3,  8.0, 0.1 ).name("Duration (s)").onChange(() => controller.applyParams()));
  allowExpand(fCore.add(params, "intensity", 0.0,  3.0, 0.01).name("Intensity").onChange(() => controller.applyParams()));

  const fStyle = fFX.addFolder("Style").close();
  allowExpand(fStyle.add(params, "speed",      0.1, 20.0, 0.1 ).name("Speed / Freq").onChange(() => controller.applyParams()));
  allowExpand(fStyle.add(params, "noiseScale", 0.1,  5.0, 0.05).name("Noise Scale").onChange(() => controller.applyParams()));
  allowExpand(fStyle.add(params, "edgeWidth",  0.02, 0.6, 0.01).name("Edge Width").onChange(() => controller.applyParams()));
  allowExpand(fStyle.add(params, "emissive",   0.0,  8.0, 0.05).name("Emissive Boost").onChange(() => controller.applyParams()));
  allowExpand(fStyle.add(params, "fadeTail",   0.0,  3.0, 0.05).name("Fade Tail (s)").onChange(() => {
    controller.fadeTailS = params.fadeTail;
  }));

  // ---- Dissolve-specific FX knobs (also bias Wave a bit) ----
  const fDis = fFX.addFolder("Dissolve FX").close();
  allowExpand(fDis.add(params, "edgeRagged", 0.0, 1.5, 0.01).name("Edge Ragged").onChange(() => controller.applyParams()));
  allowExpand(fDis.add(params, "wispAmt",    0.0, 1.5, 0.01).name("Wisp Alpha").onChange(() => controller.applyParams()));
  allowExpand(fDis.add(params, "flyMax",     0.5, 8.0, 0.05).name("Hero Fly Max").onChange(() => controller.applyParams()));
  allowExpand(fDis.add(params, "windX",     -2.0, 2.0, 0.02).name("Wind X").onChange(() => controller.applyParams()));
  allowExpand(fDis.add(params, "windY",     -2.0, 2.0, 0.02).name("Wind Y").onChange(() => controller.applyParams()));
  allowExpand(fDis.add(params, "windZ",     -2.0, 2.0, 0.02).name("Wind Z").onChange(() => controller.applyParams()));

  fFX.add({
    test: () => { controller.triggerAt(uniforms.hit.value); },
  }, "test").name("▶ Replay at last hit");
  fLayers.add(params, "splatLayer").name("Splat")
    .onChange((v) => controller.setLayerVis("splat", v));
  // Splat sub-form: segmented Gaussian / Point toggle. Lil-gui's select is
  // too hidden — render a button group inline so it sits visually under the
  // Splat checkbox.
  const subformRow = document.createElement("div");
  subformRow.className = "subform-toggle";
  // Each cell wraps a button + a hover-popover explaining what that sub-form
  // is (data source / training pipeline / per-splat data). Tooltips are
  // portalled into <body> below to escape lil-gui's panel transform.
  subformRow.innerHTML = `
    <span class="subform-cell"><button data-val="Gaussian">Gaussian</button></span>
    <span class="subform-cell"><button data-val="Point">Point</button></span>
  `;
  // Portalled tooltips
  const SUBFORM_TIPS = {
    Gaussian: `<div class="k">SOURCE</div><div class="v">Unreal Engine capture</div>
               <div class="k">TRAIN</div><div class="v">Postshot</div>
               <div class="k">SHAPE</div><div class="v">3D anisotropic Gaussian</div>
               <div class="k">DATA</div><div class="v">RGB, scales, quaternion, alpha</div>`,
    Point:    `<div class="k">SOURCE</div><div class="v">Gaussian centres collapsed</div>
               <div class="k">SHAPE</div><div class="v">isotropic point</div>
               <div class="k">SIZE</div><div class="v">uniform, set by "Point Size"</div>
               <div class="k">USE</div><div class="v">raw structure, sparse view</div>`,
  };
  subformRow.querySelectorAll(".subform-cell").forEach(cell => {
    const val = cell.querySelector("button")?.dataset.val;
    const tip = document.createElement("div");
    tip.className = "subform-tip";
    tip.innerHTML = SUBFORM_TIPS[val] || "";
    document.body.appendChild(tip);
    cell._tip = tip;
  });
  const subformSync = () => {
    subformRow.querySelectorAll("button").forEach(b =>
      b.classList.toggle("active", b.dataset.val === params.splatSubform));
  };
  subformRow.querySelectorAll("button").forEach(b => {
    b.addEventListener("click", () => {
      params.splatSubform = b.dataset.val;
      controller.applyParams();
      subformSync();
    });
  });
  subformSync();
  // Inject after the Splat checkbox row inside the Layers folder.
  const splatRow = fLayers.controllers[fLayers.controllers.length - 1].domElement;
  splatRow.insertAdjacentElement("afterend", subformRow);
  fLayers.add(params, "pointSize",  0.0005, 0.05,  0.0005).name("Point Size")
    .onChange(() => controller.applyParams());

  // "Billboard" (rather than "Quad") names the family that contains both
  // the Quad (square) and Circle (camera-facing disc) subforms.
  const quadCtrl = fLayers.add(params, "quadLayer").name("Billboard")
    .onChange((v) => controller.setLayerVis("quad", v));

  // Quad subform — Quad (square plane) vs Circle (camera-facing disc).
  // Same segmented-pill pattern as Splat's Gaussian/Point above.
  const quadShapeRow = document.createElement("div");
  quadShapeRow.className = "subform-toggle";
  quadShapeRow.innerHTML = `
    <span class="subform-cell"><button data-val="quad">Quad</button></span>
    <span class="subform-cell"><button data-val="circle">Circle</button></span>
  `;
  const QUAD_SHAPE_TIPS = {
    quad:   `<div class="k">TYPE</div><div class="v">Square billboard</div>
             <div class="k">SHADE</div><div class="v">flat colour</div>`,
    circle: `<div class="k">TYPE</div><div class="v">Camera-facing disc</div>
             <div class="k">SHADE</div><div class="v">unit-circle discard + AA edge</div>`,
  };
  quadShapeRow.querySelectorAll(".subform-cell").forEach(cell => {
    const val = cell.querySelector("button")?.dataset.val;
    const tip = document.createElement("div");
    tip.className = "subform-tip";
    tip.innerHTML = QUAD_SHAPE_TIPS[val] || "";
    document.body.appendChild(tip);
    cell._tip = tip;
  });
  const quadShapeSync = () => {
    quadShapeRow.querySelectorAll("button").forEach(b =>
      b.classList.toggle("active", b.dataset.val === params.quadShape));
  };
  quadShapeRow.querySelectorAll("button").forEach(b => {
    b.addEventListener("click", () => {
      params.quadShape = b.dataset.val;
      // main.js hooks the actual Quadizer.setShape() call through this.
      gui.__shapeCallbacks?.quad?.(params.quadShape);
      quadShapeSync();
    });
  });
  quadShapeSync();
  const quadRow = quadCtrl.domElement;
  quadRow.insertAdjacentElement("afterend", quadShapeRow);

  fLayers.add(params, "quadSize",   0.0001, 0.05,  0.0001).name("Billboard Size")
    .onChange(() => controller.applyParams());

  const voxelCtrl = fLayers.add(params, "voxelLayer").name("Voxel")
    .onChange((v) => controller.setLayerVis("voxel", v));

  // Voxel subform — Cube (BoxGeometry) vs Sphere (IcosahedronGeometry).
  // Changing this triggers a Voxelizer rebuild (different geometry buffers).
  const voxelShapeRow = document.createElement("div");
  voxelShapeRow.className = "subform-toggle";
  voxelShapeRow.innerHTML = `
    <span class="subform-cell"><button data-val="cube">Cube</button></span>
    <span class="subform-cell"><button data-val="sphere">Sphere</button></span>
  `;
  const VOXEL_SHAPE_TIPS = {
    cube:   `<div class="k">TYPE</div><div class="v">Spatial-bin cube</div>
             <div class="k">PROTO</div><div class="v">BoxGeometry, 12 tris</div>`,
    sphere: `<div class="k">TYPE</div><div class="v">Spatial-bin sphere</div>
             <div class="k">PROTO</div><div class="v">IcosahedronGeometry, 80 tris</div>`,
  };
  voxelShapeRow.querySelectorAll(".subform-cell").forEach(cell => {
    const val = cell.querySelector("button")?.dataset.val;
    const tip = document.createElement("div");
    tip.className = "subform-tip";
    tip.innerHTML = VOXEL_SHAPE_TIPS[val] || "";
    document.body.appendChild(tip);
    cell._tip = tip;
  });
  const voxelShapeSync = () => {
    voxelShapeRow.querySelectorAll("button").forEach(b =>
      b.classList.toggle("active", b.dataset.val === params.voxelShape));
  };
  voxelShapeRow.querySelectorAll("button").forEach(b => {
    b.addEventListener("click", () => {
      params.voxelShape = b.dataset.val;
      gui.__shapeCallbacks?.voxel?.(params.voxelShape);
      voxelShapeSync();
    });
  });
  voxelShapeSync();
  const voxelRow = voxelCtrl.domElement;
  voxelRow.insertAdjacentElement("afterend", voxelShapeRow);

  fLayers.add(params, "voxelSize",  0.0005, 0.40,  0.0005).name("Voxel Size")
    .onChange(() => controller.applyParams());

  // ---- USD spec badges on the Quad / Voxel rows ---------------------------
  // Both layers are conceptually USD PointInstancer overlays — one prototype
  // per layer (Plane for Quad, Cube for Voxel). The badge is a tiny inline
  // tag; hovering opens a styled popover with a short OpenUSD primer and a
  // "Read more" link that jumps to openusd.org.
  const USD_DOCS_URL = "https://openusd.org/release/api/class_usd_geom_point_instancer.html";
  // Per-family copy. TYPE names the family in plain language. BADGE is the
  // chip text shown next to the row name. PROTO lists every prototype the
  // family can hot-swap to (the Voxel family swaps the actual prim; the
  // Billboard family always uses UsdGeomPlane and changes shading only).
  const USD_FAMILY = {
    billboard: {
      type:  "Camera-facing billboard family",
      badge: "PointInstancer · Plane",
      proto: "UsdGeomPlane (Quad, Circle)",
    },
    voxel: {
      type:  "Spatial-bin instancer family",
      badge: "PointInstancer · Cube, Sphere",
      proto: "UsdGeomCube, UsdGeomSphere",
    },
  };
  const attachUsdBadge = (ctrl, key) => {
    const nameEl = ctrl.domElement.querySelector(".name");
    if (!nameEl) return;
    const info = USD_FAMILY[key];
    if (!info) return;

    const wrap = document.createElement("span");
    wrap.className = "usd-spec-wrap";
    wrap.dataset.proto = key;

    const badge = document.createElement("span");
    badge.className = "usd-spec";
    badge.textContent = info.badge;
    wrap.appendChild(badge);

    const tip = document.createElement("div");
    tip.className = "usd-tooltip";
    tip.innerHTML =
      `<div class="k">TYPE</div><div class="v">${info.type}</div>` +
      `<div class="k">SCHEMA</div><div class="v">UsdGeomPointInstancer</div>` +
      `<div class="k">PROTO</div><div class="v">${info.proto}</div>` +
      `<div class="k">ATTRS</div><div class="v">positions, orientations, scales</div>` +
      `<div class="k">COLOR</div><div class="v">primvars:displayColor (vertex)</div>` +
      `<div class="k">DOCS</div><div class="v">` +
        `<a class="t-link" href="${USD_DOCS_URL}" target="_blank" rel="noopener noreferrer">openusd.org</a>` +
      `</div>`;
    // Portal the tooltip to <body> so position:fixed isn't broken by
    // lil-gui's transform. JS toggles a .show class on hover.
    document.body.appendChild(tip);
    wrap._tip = tip;
    nameEl.appendChild(wrap);
  };
  attachUsdBadge(quadCtrl,  "billboard");
  attachUsdBadge(voxelCtrl, "voxel");

  // ---- Hover-tooltip wiring (body-portalled, viewport-clamped) -----------
  // lil-gui panels use CSS transforms which break `position: fixed` on any
  // descendant (it gets positioned relative to the transformed ancestor
  // instead of the viewport, landing off-screen). To work around that we
  // moved the tooltips into <body>, and toggle a .show class on hover.
  function pinPopover(wrap, tip) {
    const wr   = wrap.getBoundingClientRect();
    const tipW = tip.offsetWidth  || 240;
    const tipH = tip.offsetHeight || 80;
    const vw   = window.innerWidth;
    const vh   = window.innerHeight;
    const pad  = 8;
    let left = wr.left;                       // align to trigger's left
    let top  = wr.top - tipH - pad;            // default: above the trigger
    if (left + tipW > vw - pad) left = vw - pad - tipW;
    if (left < pad) left = pad;
    if (top  < pad) top  = wr.bottom + pad;    // not enough room above → below
    if (top + tipH > vh - pad) top = Math.max(pad, vh - pad - tipH);
    tip.style.left = `${left}px`;
    tip.style.top  = `${top}px`;
  }
  function installPopover(wrap, tip) {
    if (!wrap || !tip) return;
    // CSS already hides the tooltip by default (opacity:0 + visibility:hidden).
    // Toggle the `.show` class — its `!important` rules win over the defaults.
    // Measure layout BEFORE adding .show so the box has dimensions, then pin.
    const show = () => {
      // Force a layout pass: temporarily make it measurable without flashing.
      tip.style.visibility = "hidden";
      tip.style.opacity    = "0";
      tip.classList.add("show");
      pinPopover(wrap, tip);
      tip.style.visibility = "";
      tip.style.opacity    = "";
    };
    const hide = () => { tip.classList.remove("show"); };
    // Expose programmatic handles so callers (e.g. the first-visit
    // onboarding cinematic) can pop the tip without needing to dispatch
    // synthetic mouse events.
    wrap._show = show;
    wrap._hide = hide;
    wrap.addEventListener("mouseenter", show);
    wrap.addEventListener("mouseleave", hide);
    tip .addEventListener("mouseleave", hide);
  }
  gui.domElement.querySelectorAll(".usd-spec-wrap").forEach(w => installPopover(w, w._tip));
  gui.domElement.querySelectorAll(".subform-cell" ).forEach(w => installPopover(w, w._tip));

  // ---- Reveal Mask — temporarily disabled in the UI -----------------------
  // The mask uniforms still exist for the shader but the GUI surface is
  // hidden so the user isn't confused by knobs that aren't being used right
  // now. Force the mask off as well so any stale hand-tracking state can't
  // bleed through.
  uniforms.maskActive.value = 0.0;

  // Expose folder refs so postfx.attachGUI / main.js can place their
  // controls inside the right parents (Customize / FX / 3DGS-USD).
  gui.fCustomize = fCustomize;
  gui.fFX        = fFX;
  gui.fLayers    = fLayers;

  return gui;
}
