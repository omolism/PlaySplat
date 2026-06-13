import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { createScanModifier, EffectController, buildGUI, params as effectParams } from "./effects.js";
import { Profiler } from "./profiler.js";
import { TechSpec, TECH_SPECS } from "./tech-spec.js";
import { AssetHoverManager } from "./asset-hover.js";
import { AnnotationManager } from "./annotations.js";
import { HandController } from "./handtracking.js";
import { setupPostFX } from "./postfx.js";
import { DataLabelLayer } from "./datalabels.js";
import { VelocityField } from "./velocity-field.js";
import { GPGPUParticles } from "./gpgpu-particles.js";
// SortedParticles removed — replaced by the WarpFx post-process pass.
import { Voxelizer } from "./voxelizer.js";
import { Quadizer }  from "./quadizer.js";
// PipelineHUD removed — the 3DGS/USD panel now occupies that slot.
import { SceneLayers } from "./scene-layers.js";
import { KeyHints } from "./key-hints.js";
import { ViewpointTuner } from "./viewpoint-tuner.js";
import { Credits } from "./credits.js";
import { About } from "./about.js";
import { IntroOverlay } from "./intro-overlay.js";
import { IntroRecorder } from "./intro-recorder.js";
import { MobileNav } from "./mobile-nav.js";
import { HandLandmarksOverlay } from "./hand-landmarks-overlay.js";
// CinematicFlourish import dropped — the end-card was retired per user
// feedback. The module remains in src/ but no longer ships in the bundle.
// import { CinematicFlourish }   from "./cinematic-flourish.js";
import { MobileUI } from "./mobile-ui.js";
import { haptic }   from "./haptic.js";
import { playSound, primeSound } from "./sounds.js";
// Poster Mode was spun out into its own repo at
// https://github.com/omolism/PlaySplat-Poster. The src/poster/ folder
// + public/poster/ assets + the mode-toggle + the dispatch path in the
// render loop all live there now. This repo is Studio Mode only.

// Web Audio AudioContext can only start after a user gesture (modern
// browser autoplay policy). We attach a one-shot primer on the FIRST
// pointerdown / keydown — by the time the user has interacted with
// anything in the page, the context is materialised and resumed, so
// every subsequent playSound() lands on the first attempt instead of
// silently being eaten by a suspended context. The listeners remove
// themselves after firing once.
{
  const primeOnce = () => {
    primeSound();
    document.removeEventListener("pointerdown", primeOnce, true);
    document.removeEventListener("keydown",     primeOnce, true);
    document.removeEventListener("touchstart",  primeOnce, true);
  };
  document.addEventListener("pointerdown", primeOnce, true);
  document.addEventListener("keydown",     primeOnce, true);
  document.addEventListener("touchstart",  primeOnce, true);
}
import { UsdLayers } from "./usd-layers.js";
import { Playbar } from "./playbar.js";
import { Turntable } from "./turntable.js";
import { UsdAnnotations } from "./usd-annotations.js";
import { uniforms as effectUniforms } from "./effects.js";
import { loadColmapImages, buildColmapFrustums, colmapCameraPosition, colmapCameraRotation } from "./colmap-loader.js";

// All public-folder assets resolve against BASE_URL so the same build
// works at the root (`npm run dev`) and under a sub-path (GitHub Pages
// — `/PlaySplat/`). BASE_URL always ends with "/" so plain
// concatenation is safe.
const BASE = import.meta.env.BASE_URL;
// Default landing scene. Switch SCENE to flip the bundled asset. Each entry
// declares whether it ships the garden-specific authored extras: the COLMAP
// capture frustums (public/colmap/*.bin) and the hand-authored FBX camera
// flythrough. A generic dropped-in scene like `train` has neither, so those
// are guarded off (see `SCENE.authored` below) and the viewer lands directly
// in the interactive state instead of swooping through coordinates that
// don't match the scene.
const SCENES = {
  train:  { file: "train.splat",        authored: false },
  garden: { file: "PlaySplat_PC.splat", authored: true  },
};
const SCENE = SCENES.train;
const SPLAT_URL = `${BASE}${SCENE.file}`;
// Mobile variant — same 3 M splats, just re-encoded as SPZ (Niantic's
// open-sourced compressed format). SPZ typically lands at 30-50% of the
// uncompressed .splat size with no visible quality loss, so phones over
// a metered link feel the difference but the showcase still ships every
// splat the desktop sees. NOT a downsampled "mobile-quality" variant —
// that fork was retired ("no reason to sacrifice detail") and this slot
// stays purely about bandwidth, not fidelity.
//
// Shipping is OPTIONAL. If the .spz file is not present in /public the
// HEAD probe in pickSplatUrl() below 404s and the loader gracefully
// falls back to SPLAT_URL — every device still works, only the mobile
// bandwidth win goes unrealised. Generate the .spz from the same
// PlaySplat_PC.splat by running `node scripts/generate-spz-v3.mjs`;
// the script uses Spark's own transcodeSpz so the output version
// matches whatever the shipped runtime can decode (0.1.10 → v3, v2.x →
// v4). External tools (PlayCanvas SuperSplat, Niantic CLI) also work
// as long as the SPZ version matches the Spark runtime — see
// _archive/README.md for the version-mismatch troubleshooting story.
const SPLAT_MOBILE_URL = `${BASE}PlaySplat_Mobile.spz`;

// Resolve the splat URL to load. Phones get a HEAD probe on the SPZ
// variant first; if it 404s we fall back to the full .splat. The probe
// adds ~50-200 ms but only runs on IS_PHONE, and it's lost in the noise
// of the multi-second splat download that follows. Desktop / iPad skip
// the probe entirely (the "iPad === PC" project direction means tablet
// users get the same full-fidelity asset as desktop).
async function pickSplatUrl() {
  if (!IS_PHONE) return SPLAT_URL;
  try {
    const r = await fetch(SPLAT_MOBILE_URL, { method: "HEAD" });
    if (r.ok) {
      console.info(`[splat] phone variant available, using ${SPLAT_MOBILE_URL}`);
      return SPLAT_MOBILE_URL;
    }
  } catch { /* network / CORS — fall through to default */ }
  console.info(`[splat] phone variant unavailable, falling back to ${SPLAT_URL}`);
  return SPLAT_URL;
}

// Map a URL's extension to Spark's SplatFileType enum value. Used so
// the mobile variant can be either .splat or .spz / .ply / .ksplat
// without the call-site having to special-case each format.
function splatTypeFromUrl(url) {
  const m = String(url).toLowerCase().match(/\.(splat|spz|ply|ksplat)(?:\?|#|$)/);
  return m ? m[1] : "splat";
}

// ---------------------------------------------------------------------------
// High-end mobile heuristic. Returns true for touch devices whose
// browser-observable signals correlate with iPhone 13+ (or equivalent
// Android flagship / modern iPad). The browser doesn't expose enough
// info to identify exact chips (Apple intentionally hides it), so this
// is a multi-signal proxy that intentionally errs on the conservative
// side — false-negatives just mean a powerful device gets the smaller
// asset, which still works fine; false-positives risk a slow phone
// trying to render 3M splats. Tune the thresholds if real-world data
// suggests they're too tight / loose.
//
// Signals used:
//   • UA → which OS family + iOS major version
//   • devicePixelRatio: dpr 3 ≈ iPhone 12+ (iPhone 11 = dpr 2)
//   • hardwareConcurrency: 6+ cores ≈ A14+, 8+ ≈ flagship Android
//   • deviceMemory: 4 GB+ where exposed (Chromium-only, not Safari)
//
// Window-exposed (__isHighEndMobile) so the call can be inspected /
// overridden from DevTools without a rebuild.
function isHighEndMobile() {
  if (!IS_TOUCH) return false;

  const ua    = navigator.userAgent || "";
  const cores = navigator.hardwareConcurrency || 0;
  const dpr   = window.devicePixelRatio || 1;
  const mem   = navigator.deviceMemory || 0;

  // iPad / iPadOS-in-desktop-UA. Per project direction "iPad === PC",
  // EVERY iPad gets the un-optimized PC splat regardless of core
  // count. Older iPads are rare in the wild and the budget cap path
  // (SPLAT_MAX_TABLET, applied downstream) is enough of a safety net
  // for anything genuinely starved for memory — we'd rather risk a
  // slow first load on a 2017 iPad than ship the mobile-quality
  // variant to a 2024 M4 iPad and undersell the showcase.
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
    return true;
  }

  // iPhone. The cleanest browser-observable cutoff is dpr === 3 (iPhone
  // 12+) — iPhone 11 and below report dpr 2. Combined with iOS 15+ and
  // 6+ cores this approximates "A14 chip or newer", which includes the
  // iPhone 13 family the user named plus iPhone 12 (A14, ~20% slower
  // than A15 but still well within the 3M-splat budget).
  if (/iPhone|iPod/.test(ua)) {
    const m    = ua.match(/OS (\d+)_/);
    const iosV = m ? parseInt(m[1], 10) : 0;
    return iosV >= 15 && cores >= 6 && dpr >= 3;
  }

  // Android flagship signature: 8+ cores, 4+ GB exposed RAM (or
  // unexposed — some browsers omit deviceMemory), dpr ≥ 2.5.
  if (/Android/.test(ua)) {
    return cores >= 8 && (mem === 0 || mem >= 4) && dpr >= 2.5;
  }

  // Other touch surfaces (touchscreen laptops, niche): default to false.
  return false;
}
window.__isHighEndMobile = isHighEndMobile;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const canvas       = document.getElementById("viewport");
const loadingEl    = document.getElementById("loading");
const loadingText  = document.getElementById("loading-text");

// ---- WebGL2 pre-flight (PM-13) ------------------------------------------
// Spark requires WebGL2. Older browsers / locked-down corporate machines
// may not have it. Detecting BEFORE we kick off the 90 MB splat download
// saves the user a long wait followed by a cryptic console error.
function _showFatalError(title, body, retry = true) {
  const el = document.createElement("div");
  el.className = "fatal-error";
  el.setAttribute("role", "alert");
  el.innerHTML = `
    <div class="fe-card">
      <div class="fe-title">${title}</div>
      <div class="fe-body">${body}</div>
      ${retry ? `<button class="fe-retry" type="button">Try again</button>` : ""}
    </div>`;
  document.body.appendChild(el);
  el.querySelector(".fe-retry")?.addEventListener("click", () => location.reload());
  // Hide the still-spinning loading splash since we've shipped a worse
  // error state and don't want the two stacking visually.
  document.getElementById("loading")?.classList.add("hidden");
  return el;
}
window.__showFatalError = _showFatalError;
(function _preflightWebGL2() {
  let gl;
  try { gl = canvas.getContext("webgl2"); } catch {}
  if (!gl) {
    _showFatalError(
      "WebGL 2 not available",
      "PlaySplat requires WebGL 2 to render 3D Gaussian Splats. " +
      "Most current Chrome / Edge / Firefox / Safari versions support it — " +
      "please try a recent browser, or check whether hardware acceleration " +
      "is disabled in your browser settings.",
      true,
    );
    throw new Error("WebGL2 unavailable — halting boot");
  }
})();
const annoLayer    = document.getElementById("annotation-layer");
const viewList     = document.getElementById("viewpoint-list");
const addBtn       = document.getElementById("add-viewpoint");
const shareBtn     = document.getElementById("share-viewpoint");
const statusEl     = document.getElementById("status");
// "Copy link to this viewpoint" — wires to the share helper defined inside
// loadSplat (it needs the camera/controls). Guard for early clicks before
// the helper is wired.
shareBtn?.addEventListener("click", () => {
  if (typeof window.__copyViewLink === "function") window.__copyViewLink();
  else statusEl.textContent = "Scene still loading, try again in a moment";
});
// "Play viewpoint tour" — strings the saved viewpoints into a smooth
// Catmull-Rom flight via the Turntable's sequence mode (wired in loadSplat).
const playVpBtn = document.getElementById("play-viewpoints");
playVpBtn?.addEventListener("click", () => {
  if (typeof window.__playViewpointTour === "function") window.__playViewpointTour();
  else statusEl.textContent = "Scene still loading, try again in a moment";
});
const handToggle   = document.getElementById("hand-toggle");
const handVideo    = document.getElementById("hand-video");
const handCursor   = document.getElementById("hand-cursor");
const handCursor2  = document.getElementById("hand-cursor-2");
const handModeEl   = document.getElementById("hand-mode");

// ---------------------------------------------------------------------------
// Mobile detection — applied ONLY when the user is on a touch device.
// Desktop behaviour is untouched. Mobile flips a body class for CSS overrides,
// caps the pixel ratio harder (mobile GPUs choke on full retina at 2.6 M
// splats), disables expensive post-fx by default, auto-collapses the GUI so
// it doesn't eat half the screen, and hides hand-tracking (front-cam +
// MediaPipe is battery murder on phones).
// ---------------------------------------------------------------------------
// Touch / mobile detection. Primary signal is `(pointer: coarse)` —
// that reflects the *primary* pointing device, not just touch-capability,
// so a Windows laptop with a touchscreen but a mouse plugged in does NOT
// trip it.
//
// iPad detection is hardened on top: iPads (including the ones that lie
// about being macOS via desktop-UA mode) are always classified as TABLET
// regardless of viewport width. Without this, an iPad held in portrait
// + dragged into Split-View at 50 % drops below 768 px and falls into
// IS_PHONE, which would surface the phone-only mobile UI on a device
// the user has explicitly said should match the desktop layout.
const _ua      = navigator.userAgent || "";
const IS_IPAD  = /iPad/.test(_ua) || (/Macintosh/.test(_ua) && navigator.maxTouchPoints > 1);
const IS_TOUCH = (window.matchMedia?.("(pointer: coarse)").matches ?? false) || IS_IPAD;
const IS_PHONE  = IS_TOUCH && !IS_IPAD && window.innerWidth <  768;
const IS_TABLET = IS_TOUCH && ( IS_IPAD || window.innerWidth >= 768);
// Back-compat name — legacy code paths read IS_MOBILE.
const IS_MOBILE = IS_PHONE;
document.body.classList.toggle("touch",  IS_TOUCH);
// Sticky "is a phone-class device" flag — bound to the hardware (touch
// + not iPad), so it survives orientation changes. Distinct from the
// reactive `.phone` / `.mobile` classes below, which are RE-EVALUATED
// on resize and flip off when an iPhone rotates into landscape and
// crosses the 768-px width threshold (iPhone 14 PM landscape ≈ 932 px).
// Use this when a UI fragment is meaningless on a phone regardless of
// orientation — e.g. keyboard-shortcut hints inside Viewpoints, which
// have no keyboard to drive them either way.
document.body.classList.toggle("phone-device", IS_TOUCH && !IS_IPAD);
// Phone / tablet / mobile classes are RE-EVALUATED on resize / rotation
// so the same iPhone in portrait → phone UI / in landscape → tablet UI
// (the user explicitly asked for phone landscape to "reference iPad's
// visual"). The IS_TOUCH const stays sticky because touch capability
// itself can't change at runtime.
function _applyOrientationClasses() {
  const phone  = IS_TOUCH && !IS_IPAD && window.innerWidth <  768;
  const tablet = IS_TOUCH && ( IS_IPAD || window.innerWidth >= 768);
  document.body.classList.toggle("phone",  phone);
  document.body.classList.toggle("tablet", tablet);
  document.body.classList.toggle("mobile", phone);   // legacy alias
}
_applyOrientationClasses();
window.addEventListener("resize", _applyOrientationClasses);
window.addEventListener("orientationchange", _applyOrientationClasses);

// ---------------------------------------------------------------------------
// Collapsible panels — Viewpoints (#sidebar), Scene (#scene-panel), and
// Hand Tracking (#hand-panel). Each one's chevron button toggles in
// both directions: when expanded the panel shows fully, when collapsed
// it shrinks to a 38 × 38 tab in place (the chevron flips via CSS to
// read as "expand"). The collapsed tab IS the affordance, so the
// expand handle is always at the same Y coordinate as the panel was —
// no floating-fixed-position math to keep in sync with layout shifts.
// State persists via localStorage. Skipped on phone (panels CSS-hidden).
// ---------------------------------------------------------------------------
function setupCollapsiblePanel({
  panelSelector,      // CSS selector for the panel element
  toggleSelector,     // CSS selector for the in-panel chevron button
  storageKey,         // localStorage key for persisting the collapsed flag
  minimizedClass,     // class added to the panel when collapsed
  bodyClass,          // class added to body when collapsed (CSS hook)
}) {
  const panel = document.querySelector(panelSelector);
  if (!panel) return null;
  const toggleBtn = panel.querySelector(toggleSelector);
  if (!toggleBtn) return null;

  const setCollapsed = (on, persist = true) => {
    panel.classList.toggle(minimizedClass, on);
    document.body.classList.toggle(bodyClass, on);
    toggleBtn.setAttribute("aria-expanded", String(!on));
    toggleBtn.title = on ? "Expand panel" : "Collapse panel";
    toggleBtn.setAttribute("aria-label", on ? "Expand panel" : "Collapse panel");
    if (persist) {
      try { localStorage.setItem(storageKey, on ? "1" : "0"); } catch {}
    }
  };

  // Same chevron handles both directions — toggles the current state.
  toggleBtn.addEventListener("click", () => {
    setCollapsed(!panel.classList.contains(minimizedClass));
  });

  if (!IS_PHONE) {
    try {
      if (localStorage.getItem(storageKey) === "1") setCollapsed(true, false);
    } catch {}
  }
  return {
    setCollapsed,
    isCollapsed: () => panel.classList.contains(minimizedClass),
  };
}

// Module-level handles so the intro playback (camMoveStartLerps /
// camMoveRevertLerps, defined inside loadSplat below) can collapse +
// restore all panels in a single coordinated motion.
const _sidebarCollapseCtrl = setupCollapsiblePanel({
  panelSelector:  "#sidebar",
  toggleSelector: "#sidebar-toggle",
  storageKey:     "playsplat:sidebar-collapsed",
  minimizedClass: "sidebar-minimized",
  bodyClass:      "has-collapsed-sidebar",
});
const _handCollapseCtrl = setupCollapsiblePanel({
  panelSelector:  "#hand-panel",
  toggleSelector: "#hand-min-toggle",
  storageKey:     "playsplat:hand-collapsed",
  minimizedClass: "hand-minimized",
  bodyClass:      "has-collapsed-hand",
});
let _sceneCollapseCtrl = null;   // wired below after SceneLayers is built
// (Scene panel collapse is set up below, after SceneLayers is built —
// scene-layers.js attaches the chevron button as part of its DOM.)

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
// preserveDrawingBuffer enables canvas.toDataURL() for the A/B Compare
// snapshot path. Minor GPU cost; the headline cost was already paid by
// post-FX render targets.
// Renderer-preference feature flag — Spark 0.1.10 is WebGL 2-only, but
// the Spark roadmap includes a WebGPU backend. Reading `?renderer=webgpu`
// from the URL lets us opt-in once Spark exposes the path without
// shipping a follow-up build. Today the flag is logged for visibility
// and falls back to WebGL 2; the URL param + window-exposed pref means
// a future WebGPU enablement is a single SparkRenderer-options change.
const RENDERER_PREF = (() => {
  try {
    const v = new URLSearchParams(window.location.search).get("renderer");
    return v === "webgpu" ? "webgpu" : "webgl2";
  } catch { return "webgl2"; }
})();
window.__rendererPref = RENDERER_PREF;
if (RENDERER_PREF === "webgpu") {
  console.info("[renderer] WebGPU requested via ?renderer=webgpu URL param. Spark 0.1.10 doesn't expose WebGPU yet, falling back to WebGL 2. The flag is recorded on window.__rendererPref for future activation.");
}
// powerPreference: "high-performance" tells the browser we want the
// discrete GPU on dual-GPU laptops (NVIDIA / AMD instead of the Intel
// iGPU). Without this hint Chrome / Edge default to the iGPU for power
// savings, so even a workstation laptop with an RTX 5070 Ti ends up
// running the 3M-splat scene on Intel Graphics — visible in Task
// Manager as 0% NVIDIA + 90%+ Intel. The hint propagates into the
// WebGL context attributes that Spark inherits, so Spark's splat
// rasteriser lands on the discrete GPU too. Note: this is a HINT,
// not a guarantee — Windows / browser per-app graphics prefs can
// still override (see the OS-side toggle in the README's deploy
// notes).
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  preserveDrawingBuffer: true,
  powerPreference: "high-performance",
});
// Pixel-ratio policy. The old cap of `min(dpr, 2)` matched native iPad/Retina
// pixel density, but the user reported the iPad Air emulator in Chrome
// DevTools rendered softer than expected — "looks like the mobile asset
// even though PlaySplat_PC is loaded". Root cause: DevTools' iPad preset
// often inherits the HOST monitor's devicePixelRatio (so a 1080p workstation
// reports dpr=1), and at dpr=1 the 3M-splat scene is rasterised at exactly
// CSS-pixel resolution with no headroom for the anti-aliasing the projected
// Gaussians need to read as sharp.
//
// Updated policy:
//   • Phone   — cap at 1.5× (fill-rate constrained; bumping higher
//     thrashes thermals on the same hardware that has a small screen
//     anyway).
//   • Non-phone (tablet / iPad / desktop) — FLOOR at 1.5× and cap at 3×.
//     The floor means a dpr=1 host gets a "free" 1.5× SSAA pass (2.25×
//     the pixels, comfortable for a discrete or modern integrated GPU on
//     3M splats). The cap at 3 honours iPhone Pro / iPad Pro Retina-3×
//     without uncapped 4×+ on extreme external displays.
//
// Console-logged so the user can verify in DevTools which ratio actually
// applied for their device/emulator combination.
// ---- Performance preference ---------------------------------------------
// Single user-facing dial — `Battery / Balanced / Max Quality` — that drives
// pixel-ratio cap, bloom default, and particles default. Persists across
// sessions in localStorage. A laptop user on battery can knock the whole
// experience to "Battery" once and stop fighting the fan; a desktop user
// can opt INTO Max Quality (uncapped DPR + bloom + particles ON) without
// hunting through three folders.
//
// Profile values:
//   battery   — dpr 1.0, bloom OFF, particles OFF  (fan-friendly)
//   balanced  — dpr device-default (1.5 phone / 1.5-floor-3-cap desktop),
//               bloom OFF, particles OFF  (the current shipped defaults)
//   max       — dpr 3.0, bloom ON, particles ON  (showcase mode)
const PERF_PREF_KEY = "playsplat:perf";
const PERF_PROFILES = {
  battery:  { dprCap: 1.0,  bloom: false, particles: false },
  balanced: { dprCap: null, bloom: false, particles: false },   // null = device-default
  max:      { dprCap: 3.0,  bloom: true,  particles: true  },
};
// Default profile is phone-aware. IS_PHONE devices start in "battery"
// so first-time mobile visitors get DPR 1.0 + no bloom + no particles
// out of the box (their hardware fights the fan otherwise, and a 3M
// splat at full retina + bloom on a budget Android = single-digit FPS).
// Desktop / iPad keep the original "balanced" default so the showcase
// still lands at the intended fidelity on capable hardware. User can
// always opt into Max Quality through the Performance dropdown; the
// override persists across sessions via the same localStorage key, so
// repeat phone visitors who explicitly bumped past Battery don't get
// snapped back to it on every page load.
const _perfDefault = IS_PHONE ? "battery" : "balanced";
let _perfPref;
try { _perfPref = localStorage.getItem(PERF_PREF_KEY) || _perfDefault; } catch { _perfPref = _perfDefault; }
if (!(_perfPref in PERF_PROFILES)) _perfPref = _perfDefault;
const _perfProfile = PERF_PROFILES[_perfPref];

const _hostDpr    = window.devicePixelRatio || 1;
const _deviceDpr  = IS_MOBILE
  ? Math.min(_hostDpr, 1.5)
  : Math.min(Math.max(_hostDpr, 1.5), 3);
const _dprApplied = _perfProfile.dprCap !== null
  ? Math.min(_hostDpr, _perfProfile.dprCap)    // explicit perf-profile cap
  : _deviceDpr;                                // device-default cap
renderer.setPixelRatio(_dprApplied);
console.info(
  `[renderer] perf=${_perfPref} devicePixelRatio=${_hostDpr} applied=${_dprApplied}` +
  ` (IS_PHONE=${IS_PHONE} IS_TABLET=${IS_TABLET} IS_IPAD=${IS_IPAD})`,
);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x0b0f14, 1);

const scene = new THREE.Scene();
// SuperSplat / PlayCanvas-style "filled" rendering. The user noted that
// SuperSplat's web viewer renders the same scene without the pinhole gaps
// our default render shows. Two Spark knobs close the gap:
//
//   • preBlurAmount: 0.3  — adds 0.3 to each splat's 2D covariance diagonal,
//     enlarging Gaussians so neighbours overlap. This is the documented
//     default for splats trained WITHOUT the Inria anti-aliasing tweak
//     (which describes Postshot / vanilla Inria pipelines). The Spark
//     default is 0.0, which leaves the raw Gaussians and produces the
//     pinhole look — visible especially on tile boundaries and edges.
//
//   • focalAdjustment: 2.0 — matches the splat-scale convention used by
//     PlayCanvas / SuperSplat. Doubles the projected splat size relative to
//     Spark's default of 1.0. Combined with preBlurAmount it reads as
//     "every splat is a slightly larger soft blob" — the look the user
//     called out as "把洞都给补上了" (holes are filled).
//
// These are renderer-level uniforms, so they apply uniformly across the
// primary AND any imported secondary layers — no per-layer tuning needed.
const spark = new SparkRenderer({
  renderer,
  preBlurAmount:    0.3,
  focalAdjustment:  2.0,
});
scene.add(spark);

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.01,
  2000,
);
camera.position.set(0, 1.5, 4);
scene.add(camera);

window.__cam = { camera };
const controls = new OrbitControls(camera, canvas);
// (Idle ambient orbit drift removed by user request — the scene now
//  stays absolutely still when nobody is interacting with it.)
window.__cam.controls = controls;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.7;
controls.zoomSpeed = 0.9;
controls.panSpeed = 0.7;
controls.minDistance = 0.05;
controls.maxDistance = 200;

// Procedural bbox-derived orbit for non-bundled scenes — see turntable.js.
// The authored camera move stays the tour for the bundled scene; this is
// the zero-config fallback that frames anything the user drags in.
const turntable = new Turntable({ camera, controls });
window.__turntable = turntable;
// Grabbing the orbit cancels the tour, mirroring the camera move's lockout.
canvas.addEventListener("pointerdown", () => turntable.stop(), { capture: true });

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Post-FX (kaleidoscope) — wraps renderer with EffectComposer
// ---------------------------------------------------------------------------
const postfx = setupPostFX(renderer, scene, camera);
postfx.setSize(window.innerWidth, window.innerHeight);

// Phase-1 foundation: 2D velocity-conservation field. Hand pinch + mouse
// press inject mass/velocity at the input UV; the field convolves + advects
// each frame, exposing its current state via getTexture() for downstream
// passes (particles, voxel particles) to consume.
// Cheap at 256x256 half-float (~1ms/frame), so stepped unconditionally.
const velocityField = new VelocityField(renderer, { resolution: 256 });
window.__velocityField = velocityField;   // dev affordance for runtime inspection

// GPGPU particle system that advects through the velocity field.
// 64² = 4096 additive point sprites; off by default until the user enables
// it via the FX GUI. Bounds set wide so particles spread through a typical
// splat scene (~10 m wide).
const gpgpuParticles = new GPGPUParticles(renderer, {
  size:   64,
  bounds: { min: [-6, -2, -6], max: [6, 6, 6] },
  maxAge: 4.0,
});
// Particles live in a SEPARATE scene rendered AFTER the composer with
// autoClear=false, so they bypass every post-FX pass (Echo trails, Bloom,
// Underwater, etc.) — they always read as crisp additive sprites on top
// of the finished frame. depthTest is off since the screen depth buffer
// isn't reliable post-composer; tradeoff = particles never occlude behind
// scene geometry (additive overlay only).
gpgpuParticles.renderMat.depthTest = false;
const particleScene = new THREE.Scene();
particleScene.add(gpgpuParticles.points);
window.__gpgpuParticles = gpgpuParticles;

// Pipeline HUD removed — its slot is now the 3DGS/USD panel. _hudRefs is
// retained as a no-op bag because several code paths still write to it
// (splat / voxelizer / quadizer / sceneLayers); nothing reads it now.
const _hudRefs = {};

// Profiler — per-phase wall-clock frame timing. Toggle with P.
const profiler = new Profiler({
  mountEl: document.getElementById("app") || document.body,
});
window.__profiler = profiler;

// Tech Spec — research-bibliography overlay. Toggle with T.
// Mounted to <body> (not #app) so its z-index isn't trapped inside #app's
// fixed-positioned stacking context — otherwise lil-gui (z-index 1001 on
// <body>) would draw over it.
const techSpec = new TechSpec({
  mountEl: document.body,
});
window.__techSpec = techSpec;

// Scene layers — SuperSplat-style panel with per-layer visibility toggles.
// First splat added (in loadSplat below) becomes the primary; subsequent
// drag-drop or "+ Add" calls append secondary layers that can be hidden /
// removed without touching the primary's effects / voxel / quad bindings.
const sceneLayers = new SceneLayers({
  scene,
  mountEl: document.getElementById("left-stack") || document.body,
});
// Bridge the Scene-panel primary-layer eye toggle to the 3DGS shader
// visibility. mesh.visible = false alone wasn't fully hiding the splat
// (the user reported "everything toggled off, splat still showing"),
// because the 3DGS/USD panel's Splat toggle drives a SEPARATE shader-
// alpha path via effects.setLayerVis. Without this bridge the two
// systems were independent: hiding the primary in the Scene panel
// left the shader at alpha 1.0, and the splat stayed visible.
// `effects` is hoisted later in this file; the guard tolerates the
// race where this callback fires before the bridge target is wired.
sceneLayers.onVisibilityChange = (_id, on, isPrimary) => {
  // Retarget effects / raycast / effector-mesh FIRST, so the FX modifier
  // and the shader-alpha bridge below both land on the layer that remains
  // visible. Fixes the bug where importing a second 3DGS and hiding the
  // primary left clicks silently no-op'ing (raycaster was bound to the
  // now-invisible primary).
  // Defers through window.__retargetInteractiveLayer because the actual
  // function is defined later (it depends on `splat`, `effects`, `raycaster`,
  // `effectorMesh`, all of which are initialised inside loadSplat below).
  window.__retargetInteractiveLayer?.();
  // Shader-alpha bridge: zero the splat alpha only when NO splat layer
  // remains visible. uniforms.splatVis is shared module state applied to
  // whichever mesh carries the FX modifier — after a retarget that is the
  // surviving secondary, so forcing alpha 0 on a primary-eye-off (the old
  // behaviour) faded out the secondary too ("hide garden hides train").
  if (typeof effects !== "undefined" && effects?.setLayerVis) {
    const anyVisible = sceneLayers.getVisibleMeshes().length > 0;
    const splatOn = (typeof effectParams !== "undefined" && effectParams)
      ? effectParams.splatLayer !== false
      : true;
    effects.setLayerVis("splat", anyVisible && splatOn);
  }

  // Hide every scene-anchored overlay when the primary splat is hidden
  // (asset hotspot dots, numbered viewpoint anchors, data labels, COLMAP
  // training-camera frustums). Otherwise these float in empty space —
  // user reported them as "orphan cards" once they hid the scene.
  // Restoring visibility on toggle-back honours each subsystem's own
  // toggle state (the Tech Spec panel ON checkbox for hotspots /
  // labels / cameras), so we don't overwrite a user's prior choice.
  if (isPrimary) {
    if (typeof assetHover    !== "undefined") assetHover?.setVisible(on && (window.__techEnableValue ?? true));
    if (typeof annotations   !== "undefined") annotations?.setVisible?.(on);
    if (typeof dataLabels    !== "undefined" && dataLabels?.setEnabled) {
      // Only restore data labels if the user had them ON before. We track
      // the last-user-set value on the controller, falling back to off.
      const dataParamsOn = window.__dataLabelsUserOn ?? false;
      dataLabels.setEnabled(on && dataParamsOn);
    }
    if (typeof cameraFrustums !== "undefined" && cameraFrustums) {
      cameraFrustums.visible = on && (window.__camFrustumsUserOn ?? false);
    }
  }
};
window.__sceneLayers = sceneLayers;
_hudRefs.sceneLayers = sceneLayers;   // RENDER HUD sums splats across visible layers
// Scene panel collapse — wired here (not earlier) because SceneLayers
// constructs its own DOM and the chevron button only exists after.
_sceneCollapseCtrl = setupCollapsiblePanel({
  panelSelector:  "#scene-panel",
  toggleSelector: "#scene-toggle",
  storageKey:     "playsplat:scene-collapsed",
  minimizedClass: "sidebar-minimized",   // reuse the same in-place tab idiom
  bodyClass:      "has-collapsed-scene",
});

// Asset hover hotspots — project each TECH_SPECS asset's worldPos onto the
// viewport. Hover a dot for the poster-style info card. worldPos values
// are raw Three.js world coords (same convention as the Gazebo viewpoint).
const assetHover = new AssetHoverManager({
  mountEl: document.getElementById("app") || document.body,
  camera,
  canvas,
  items: TECH_SPECS.flatMap(s => s.items),
});
window.__assetHover = assetHover;

// Bridge the Pipeline drawer's per-asset ON/OFF toggles to the hotspot
// manager. Initial pass replays any visibility persisted from a previous
// session (techSpec loaded it from localStorage on construction).
for (const [name, on] of techSpec.assetVisible) {
  if (on === false) assetHover.setItemVisible(name, false);
}
techSpec.onAssetToggle = (name, on) => assetHover.setItemVisible(name, on);

// When the Tech Breakdown drawer opens, the lil-gui "PlaySplat Studio"
// panel on the right-rail occupies the SAME viewport edge and the two
// overlap visually (drawer is 460px wide, gui is anchored at right:18px).
// They serve different intents anyway — the drawer is a focused reading
// surface, the gui is a controls surface — so only one needs to be on
// screen at a time. body.tech-spec-open is the gate; CSS in style.css
// translates the gui off-screen + drops pointer-events while the class
// is on. Mirrors how body.intro-playing locks pointer-events during the
// cinematic intro.
techSpec.onOpenChange = (open) => {
  document.body.classList.toggle("tech-spec-open", open);
};

// Credits, intro overlay, onboarding pointers — first-visit cinematic.
// Credits is toggled from the lil-gui "Credits" checkbox (added below
// under the Tech Spec folder). The other two are driven by the camera
// move's playback state (see __camMoveTick + the mixer 'finished' hook).
const credits = new Credits({ mountEl: document.body });
// Floating "About" pill in the bottom-toolbar opens the Credits panel.
// Promoted from lil-gui's Tech Spec > Credits checkbox so visitors have
// a project-level "what is this?" entry point that doesn't require any
// drilling — see PM-6.
const _aboutBtn = document.getElementById("about-btn");
_aboutBtn?.addEventListener("click", () => {
  credits.setOpen(true);
  // Mirror the GUI checkbox state so the lil-gui control stays in sync.
  try {
    const gui = window.__gui;
    gui?.controllersRecursive?.().forEach(c => {
      if (c._name === "Credits" && typeof c.setValue === "function") c.setValue(true);
    });
  } catch {}
});
window.__credits = credits;
// About — top-centre floating CTA + dedicated project-narrative panel.
// Separate from Credits (Credits keeps team/thanks/software). Mounted
// here so the trigger pill is visible from the moment the page loads
// (the cinematic intro hides it via body.intro-playing CSS rule).
const about = new About({
  mountEl: document.body,
  onOpenTechSpec: () => window.__techSpec?.openOverlay?.(),
  onOpenCredits:  () => credits?.setOpen?.(true),
});
window.__about = about;
const introOverlay = new IntroOverlay({ mountEl: document.body });
// IntroRecorder composites the WebGL canvas + a 2D replica of the intro
// overlay text every frame, captures the stream, and writes a .webm.
// Driven from __camMoveTick (state) and from the Export Intro Video button
// in the Camera Movement folder (lifecycle).
const introRecorder = new IntroRecorder({ canvas });
window.__introRecorder = introRecorder;
window.__introOverlay = introOverlay;

// Quick Guide — bottom-centre card with mouse + key shortcuts. Auto-pops on
// scene entry (showFor below in loadSplat's end), summon back with H.
const keyHints = new KeyHints({
  mountEl: document.getElementById("app") || document.body,
});
window.__keyHints = keyHints;

// Tech-Spec overlay scene — training cameras (and any future tech-spec 3D
// gizmos) live here so they bypass the post-FX composer pipeline. Rendered
// AFTER postfx.render() with autoClear=false so they sit cleanly on top.
const techOverlayScene = new THREE.Scene();
// Touch defaults. Hand Tracking panel only hidden on PHONES (laptops
// with touchscreens + iPads can still try the feature — touch detection
// alone fired too aggressively and was hiding the panel for users with
// working webcams). Heavy post-fx passes only stripped on phones too —
// the master Post-FX toggle stays ON (per user request: phones should
// get the same colour-graded look as desktop). Only the two
// expensive passes (Bloom + Underwater) default off; everything else
// in the composer chain (tonemap, colour grade, vignette, grain) is
// cheap and stays enabled.
if (IS_PHONE) {
  // (Hand-panel display is now orientation-reactive via CSS — see the
  // `body.phone #hand-panel { display: none }` rule. The previous
  // JS-set inline `style.display = "none"` was sticky from the initial
  // PORTRAIT detection and persisted into landscape, leaving hand
  // tracking unreachable when the user rotated. User reported:
  // "手机横屏的handtracking显示有问题". CSS reacts to orientation,
  // JS doesn't.)
  postfx.params.bloomEnable   = false;
  postfx.params.underwaterOn  = false;
  // gpParticleParams.enable already defaults to false, so particles stay
  // off on phones without extra plumbing.
}
// Performance profile overrides the bloom default (and later particles —
// applied in the particles section once gpParticleParams exists). The
// profile is OR'd with the phone-default — i.e., Max-Quality on a phone
// still turns bloom on, but Battery on a desktop turns it off.
postfx.params.bloomEnable = _perfProfile.bloom;

// Status callback used by the lil-gui Performance chooser to surface a
// "reload to fully apply" hint when the user switches profiles mid-session.
// DPR + bloom-default + particles-default all branch at init from the
// persisted profile, so a live switch can update SOME state (we toggle
// bloom + particles inline below) but DPR genuinely needs a fresh boot.
window.__perfStatus = (v) => {
  // Live-apply what we can: bloom + particles toggle without reload.
  const prof = PERF_PROFILES[v] || PERF_PROFILES.balanced;
  postfx.params.bloomEnable = prof.bloom;
  if (typeof gpgpuParticles !== "undefined" && gpgpuParticles?.setEnabled) {
    gpgpuParticles.setEnabled(prof.particles);
  }
  if (typeof statusEl !== "undefined") {
    statusEl.textContent = (v === _perfPref)
      ? `Performance: ${v}`
      : `Performance: ${v} — reload to fully apply DPR`;
  }
};
// Mobile nav drawer (top-right hamburger). CSS hides it on non-touch.
const mobileNav = new MobileNav();
window.__mobileNav = mobileNav;

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  postfx.setSize(w, h);

  // Re-evaluate body orientation classes here too — the standalone
  // _applyOrientationClasses listener fires on the same `resize`, but
  // bundling the call into the resize tail makes the order
  // deterministic: phone/tablet flips before any DOM measurement that
  // CSS rules under those classes would change.
  if (typeof _applyOrientationClasses === "function") _applyOrientationClasses();

  // Clamp any inline-positioned floating panel back into the viewport.
  // When the user drags the Credits or asset-hover card to a corner
  // that exists in landscape and then rotates to portrait, the inline
  // left/top can land the panel off-screen (e.g., left=700px is fine
  // in a 932-wide landscape, dies in a 414-wide portrait). The CSS
  // viewport-relative rules can't reach inline styles, so we do it
  // here. Margin keeps a visible edge handle so the user can still
  // drag the panel back if they want.
  _clampInlinePanelsToViewport();
}
window.addEventListener("resize", onResize);

// iOS Safari + Chrome Android both fire `orientationchange` but the
// `window.innerWidth/Height` values lag by a frame or two — reading
// them inside the event handler often returns the pre-rotation size.
// Schedule a debounced re-resize so the final post-rotation dimensions
// drive the actual layout. visualViewport.resize is the most reliable
// signal for "the visible viewport just changed for real" (URL bar
// collapse, keyboard reveal, software rotation all included); we hook
// it as a belt-and-braces alongside the legacy events.
let _resizeRAF = null;
function _scheduleResize(delayMs = 0) {
  if (_resizeRAF) cancelAnimationFrame(_resizeRAF);
  if (delayMs > 0) {
    setTimeout(() => requestAnimationFrame(onResize), delayMs);
  } else {
    _resizeRAF = requestAnimationFrame(() => { _resizeRAF = null; onResize(); });
  }
}
window.addEventListener("orientationchange", () => {
  // Two follow-up ticks so we catch BOTH the immediate-but-stale
  // dimensions and the settled post-rotation values. 50 ms covers
  // most devices; 350 ms catches the slow iOS URL-bar reflow.
  _scheduleResize(0);
  _scheduleResize(50);
  _scheduleResize(350);
});
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => _scheduleResize(0));
}

// Clamp inline-positioned floating panels back into the visible
// viewport on resize / rotation. Defensive about the elements existing
// — most are mounted lazily, so a too-early call shouldn't throw.
function _clampInlinePanelsToViewport() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  // Minimum visible edge so a clamped panel still has a header-grab
  // surface inside the viewport.
  const EDGE = 32;
  const targets = [
    document.getElementById("credits"),
    document.getElementById("asset-hover-card"),
  ];
  for (const el of targets) {
    if (!el || el.hasAttribute("hidden")) continue;
    const left = parseFloat(el.style.left);
    const top  = parseFloat(el.style.top);
    if (!Number.isFinite(left) && !Number.isFinite(top)) continue;
    const rect = el.getBoundingClientRect();
    const maxLeft = Math.max(EDGE - rect.width, w - EDGE);
    const maxTop  = Math.max(EDGE - rect.height, h - EDGE);
    if (Number.isFinite(left)) {
      el.style.left = Math.min(Math.max(left, EDGE - rect.width), maxLeft) + "px";
    }
    if (Number.isFinite(top)) {
      el.style.top  = Math.min(Math.max(top, 0), maxTop) + "px";
    }
  }
}

// ---------------------------------------------------------------------------
// Load splat
// ---------------------------------------------------------------------------
function setLoading(msg) {
  if (loadingText) loadingText.textContent = msg;
}
// (Loading-splash particle FX removed — the Canvas2D implementation
//  didn't reach the bar the user wanted. Splash now reverts to the
//  static editorial layout in index.html until a better motion
//  treatment is shipped.)

// (CinematicFlourish end-card mount removed — the card was retired per
// user feedback as redundant with the opening title sequence. The class
// + CSS remain in the codebase in case a different end-card treatment
// is wanted later, but nothing instantiates it.)

function hideLoading() {
  loadingEl?.classList.add("hidden");
  // Trigger the choreographed entrance — staggered fade-in for the
  // major UI surfaces (lil-gui, sidebar, toolbar, hotspots). CSS in
  // style.css under "Choreographed entrance" owns the animations;
  // body.ui-ready is the single gate that fires the whole sequence.
  // Use rAF so the splash's own fade-out runs first frame, then the
  // UI reveal kicks in cleanly behind it.
  requestAnimationFrame(() => document.body.classList.add("ui-ready"));
}

// ---------------------------------------------------------------------------
// UI helpers shared across the rest of the boot — Snapshot button, toast,
// debug state. Live here because every consumer below this point can rely
// on them, and they don't depend on anything constructed later (renderer is
// already initialised at line ~366; effectParams is module-scope from the
// effects import; camera + controls are set up earlier in this file).
// ---------------------------------------------------------------------------

// Toast — tiny, lazy, single-instance status line at bottom-right.
// Used by the snapshot button ("Snapshot saved"), the FX color toggle,
// preset switches, and anything else that wants to confirm a change
// without stealing focus. Re-using a single DOM element means rapid-fire
// toasts just refresh the message + reset the dismiss timer.
let _toastEl    = null;
let _toastTimer = null;
window.__toast = function toast(msg, durationMs = 1500) {
  if (!_toastEl) {
    _toastEl = document.createElement("div");
    _toastEl.id = "ui-toast";
    _toastEl.setAttribute("role", "status");
    _toastEl.setAttribute("aria-live", "polite");
    document.body.appendChild(_toastEl);
  }
  _toastEl.textContent = msg;
  // Force a reflow before toggling .show so the CSS transition re-fires
  // on rapid repeats (otherwise back-to-back identical toasts would skip
  // the animation).
  _toastEl.classList.remove("show");
  void _toastEl.offsetWidth;
  _toastEl.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => _toastEl.classList.remove("show"), durationMs);
};

// Snapshot — read the current canvas as a PNG data URL and trigger a
// browser download. The renderer was constructed with
// `preserveDrawingBuffer: true` (line ~366), but in practice the backbuffer
// is often EMPTY between setAnimationLoop ticks — toDataURL fires
// synchronously from the click handler, which runs in the gap between
// frames, and many browsers / drivers return a cleared (black) buffer
// when read in that window. The fix is to explicitly render a fresh
// frame inside the click handler, immediately before toDataURL, so the
// canvas reflects the current scene + FX + postfx state at the moment
// the user pressed Snap. We mirror the same dispatch logic the main
// render loop uses (postfx if Post-Process is on, otherwise direct).
window.__captureSnapshot = function captureSnapshot() {
  try {
    const canvasEl = renderer?.domElement;
    if (!canvasEl) {
      window.__toast?.("Snapshot unavailable");
      return;
    }
    // Force a fresh composite of the scene + post-FX + particle / tech
    // overlays into the canvas backbuffer. Wrapped in try/catch each so
    // a flaky pass (e.g., postfx pipeline mid-rebuild during a setting
    // change) doesn't prevent the snapshot — we still want the user to
    // get *something* even if one overlay is temporarily unavailable.
    try {
      if (typeof postfx !== "undefined" && postfx?.params?.postEnable !== false) {
        postfx.render(0);
      } else {
        renderer.render(scene, camera);
      }
    } catch (e) { console.warn("Snapshot main render failed:", e); }
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      if (typeof gpgpuParticles !== "undefined" && gpgpuParticles?.points?.visible) {
        renderer.render(particleScene, camera);
      }
    } catch (e) { console.warn("Snapshot particle overlay skipped:", e); }
    try {
      if (typeof techOverlayScene !== "undefined" && techOverlayScene?.children?.length > 0) {
        renderer.render(techOverlayScene, camera);
      }
    } catch (e) { console.warn("Snapshot tech overlay skipped:", e); }
    renderer.autoClear = prevAutoClear;

    const dataUrl = canvasEl.toDataURL("image/png");
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const link = document.createElement("a");
    link.download = `playsplat-${ts}.png`;
    link.href = dataUrl;
    // Anchor must be in the DOM for some browsers to honour download.
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.__toast?.("Snapshot saved");
  } catch (err) {
    console.error("Snapshot failed:", err);
    window.__toast?.("Snapshot failed");
  }
};

// Read-only state snapshot for analytics / URL-state serialization /
// "what was the user looking at when the bug happened" debugging. Accessed
// via `window.__playsplatState` in DevTools. Camera pose is the most
// useful field — it round-trips into the existing #v=... deep-link
// format. The getter form means each read returns a FRESH snapshot.
Object.defineProperty(window, "__playsplatState", {
  configurable: true,
  get() {
    return {
      camera: {
        position: camera?.position?.toArray?.() ?? null,
        target:   controls?.target?.toArray?.() ?? null,
      },
      fx: {
        effect:  effectParams?.effect,
        colorOn: effectParams?.colorOn,
        color:   effectParams?.color,
      },
      layers: {
        splat: effectParams?.splatLayer,
        quad:  effectParams?.quadLayer,
        voxel: effectParams?.voxelLayer,
      },
      perf: (() => {
        try { return localStorage.getItem("playsplat:perf") || "balanced"; }
        catch { return "balanced"; }
      })(),
      timestamp: Date.now(),
    };
  },
});

// Service worker — runtime-caching PWA. Registered fire-and-forget so
// a failure (e.g., dev server quirks, locked-down enterprise browser)
// never blocks the boot. Lives in /public/sw.js (Vite copies it as-is
// to the build root) and uses stale-while-revalidate for heavy assets
// (splat, SPZ, WebP textures, JS chunks) so the second visit feels
// instant. The base path comes from import.meta.env.BASE_URL so the
// register call works in dev (`/`) and on Pages (`/PlaySplat/`).
//
// Skipped on `localhost` over `file://` because some browsers refuse
// SW registration there, and the dev experience is rebuild-heavy
// anyway — caching would just get in the way.
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    const base = import.meta.env.BASE_URL || "/";
    const swUrl = base + "sw.js";
    navigator.serviceWorker.register(swUrl, { scope: base })
      .then((reg) => console.info("[sw] registered, scope:", reg.scope))
      .catch((err) => console.info("[sw] registration skipped:", err?.message ?? err));
  });
}

// First-paint reveal — a black veil layered between the canvas and the
// splash that fades from opaque to transparent over 1.5 s once body.ui-
// ready fires. Without it the splat snaps in the moment the splash
// finishes its own fade; with it the splat materialises through a held
// black frame, which reads more like a film cut and less like a screen
// refresh. Inserted as a sibling of the splash so the splash's own
// fade-out can play on top, and z-indexed at 2 (canvas is the implicit
// base; loading splash sits much higher). Pointer-events disabled so
// it never blocks input.
(() => {
  const veil = document.createElement("div");
  veil.id = "first-paint-veil";
  veil.setAttribute("aria-hidden", "true");
  const splash = document.getElementById("loading");
  if (splash && splash.parentNode) {
    splash.parentNode.insertBefore(veil, splash);
  } else {
    document.body.appendChild(veil);
  }
})();

// Idle pulse — after 5 s of no user input, set body.idle so the hotspot
// pulse animation amplifies and cycles through the dots, telegraphing
// "these are clickable" to first-time visitors who haven't yet noticed
// the small ambient pulses. Cleared on any pointer / key / scroll
// event so an actively engaged reader never sees the attention-grabbing
// loop. Skipped while a focused-reading mode is on (drawer open, card
// pinned, hand tracking active) so we don't pulse over content the
// user is concentrating on.
(() => {
  let idleTimer = null;
  const FOCUS_BLOCKERS = ["tech-spec-open", "asset-card-pinned", "hand-active", "intro-playing"];
  const armIdle = () => {
    document.body.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (FOCUS_BLOCKERS.some((c) => document.body.classList.contains(c))) return;
      document.body.classList.add("idle");
    }, 5000);
  };
  ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"].forEach((ev) => {
    window.addEventListener(ev, armIdle, { passive: true });
  });
  armIdle();
})();

// Status-text crossfade — when the human-readable part of #status
// changes (e.g., "Playing camera move…" → "Camera move complete"),
// flash the element with a quick fade + slide so the change reads as
// intentional motion rather than a jarring text swap. The continuous
// FPS readout that gets appended every 500 ms is FILTERED OUT here so
// the status doesn't strobe every half-second — we compare the base
// text (with the " • NN.N fps" suffix stripped) to know whether the
// MEANING actually changed.
if (statusEl) {
  let _lastStatusBase = statusEl.textContent || "";
  const _statusObserver = new MutationObserver(() => {
    const current = statusEl.textContent || "";
    const base = current.replace(/\s*•\s*[\d.]+\s*fps$/, "");
    if (base !== _lastStatusBase) {
      _lastStatusBase = base;
      statusEl.classList.remove("status-flash");
      // Force a reflow so the class can be re-added and the animation re-fires.
      void statusEl.offsetHeight;
      statusEl.classList.add("status-flash");
    }
  });
  _statusObserver.observe(statusEl, { childList: true, characterData: true, subtree: true });
}

// Determinate fill driver for the splash progress bar. First call with a
// real total flips the bar out of its CSS keyframe slide (`.ld-bar-indef`)
// and into a width-driven fill. Silently no-ops when the splash isn't
// mounted (HMR / tests) or when Content-Length is unknown.
const _ldFill = loadingEl?.querySelector?.(".ld-fill") ?? null;
function setLoadProgress(loaded, total) {
  if (!_ldFill || total <= 0) return;
  if (!_ldFill.classList.contains("determinate")) {
    _ldFill.classList.add("determinate");
  }
  const pct = Math.max(0, Math.min(100, (100 * loaded) / total));
  _ldFill.style.width = `${pct}%`;
  // Pillar progress lighting — light up 01 3DGS / 02 USD / 03 AI in
  // sequence as the download crosses 33 % / 66 % / 99 %. Telegraphs
  // "we're making real progress" beyond the bare fill bar, and lets
  // the editorial pillar row earn its keep during the wait. Class is
  // sticky once set (no toggle-off) so a brief network stall doesn't
  // de-light a pillar — progress is monotonic by nature anyway.
  if (loadingEl) {
    if (pct >= 30) loadingEl.classList.add("p1");
    if (pct >= 60) loadingEl.classList.add("p2");
    if (pct >= 95) loadingEl.classList.add("p3");
  }
}

// Stream a binary asset with byte-level progress. Used instead of letting
// SplatMesh fetch the URL itself, because the indeterminate slash bar
// looks broken on slow mobile networks where the 96 MB scene takes 7+
// seconds to arrive. Returns a Uint8Array that goes straight into
// `new SplatMesh({ fileBytes })`. Memory peak is roughly 2x file size
// briefly during the concat; acceptable on modern phones (1 GB+ RAM).
async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch ${url}: ${res.status} ${res.statusText}`);
  const total  = Number(res.headers.get("Content-Length")) || 0;
  const reader = res.body?.getReader?.();
  if (!reader) {
    // Old browser fallback (no ReadableStream support) — one-shot, no
    // intermediate progress, but at least functionally correct.
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.(buf.length, buf.length);
    return buf;
  }
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

let splat = null;
let effects = null;
let annotations = null;
let viewpointTuner = null;
let dataLabels = null;
let voxelizer = null;
let quadizer = null;
let cameraFrustums = null;
// Wireframe sphere shown at the hand-effector position when Effector Mode is
// active. Parented to splat so its transform is in splat-local space (same
// space as uniforms.maskCenter), no per-frame matrix math needed.
let effectorMesh = null;

// Build a SplatMesh (either from URL or fileBytes), wait for init, and
// return its world-space bounds so the caller can reframe the camera.
async function createSplat(options) {
  const m = new SplatMesh(options);
  // Postshot / Inria export convention — flip 180° around X for Y-up world.
  m.quaternion.set(1, 0, 0, 0);
  // Spark's `m.initialized` resolves once the worker has finished parsing
  // and uploading splat data to the GPU. On a 3M-splat scene this takes
  // 2-4 s on a phone and 0.5-1.5 s on desktop — long enough that a static
  // "Decoding splat…" message reads as a hang. We swap to "Initialising
  // renderer…" right before the await so the splash advances at least
  // once during the wait; the byte-progress bar already finished
  // animating its determinate fill on fetch completion, so this is the
  // last text the user sees before the canvas paints.
  setLoading("Initialising renderer…");
  await m.initialized;
  const localBox = m.getBoundingBox(true);
  const bbox     = localBox.clone().applyMatrix4(m.matrixWorld);
  const center   = new THREE.Vector3(); bbox.getCenter(center);
  const size     = new THREE.Vector3(); bbox.getSize(size);
  const radius   = Math.max(size.x, size.y, size.z, 1.0) * 0.5;
  // Stash the bounds on the mesh so scene-agnostic camera templates
  // (Turntable tour) can frame ANY loaded splat, not just the bundled
  // scene whose flythrough was hand-authored in its own coordinates.
  m.userData.bounds = { center: center.clone(), radius };
  return { splat: m, center, size, radius };
}

// Mobile splat budgets. Caps the number of points uploaded to the GPU on
// touch devices — bytes on the wire are unchanged (no Range support in
// Spark yet) but per-frame render cost + VRAM scale ~linearly with the
// cap, which is the actual bottleneck on phone silicon. The .splat
// format from Inria / Postshot exporters is typically sorted by
// importance, so the first N splats are the visually-dominant ones.
// Set both to 0 to disable the cap (full-quality on touch too).
const SPLAT_MAX_PHONE  = 1_500_000;
const SPLAT_MAX_TABLET = 2_000_000;

// HEAD-probe a URL — returns true when the server responds with a 2xx.
// Used to detect optional mobile-only assets without triggering a 404
// download in the network panel (cleaner than a try/catch on GET, and
// faster: HEAD is one round-trip with no body transfer).
async function urlExists(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

async function loadSplat() {
  setLoading("Fetching splat…");

  // Asset selection — every device sees the full 3 M splats. On phones
  // we additionally probe for an SPZ-compressed variant (same data, ~3×
  // smaller payload); see pickSplatUrl() above. If the .spz file is not
  // shipped, phones gracefully fall back to the desktop .splat. Detail
  // loss is zero either way — only the bytes-over-the-wire differ.
  const assetUrl  = await pickSplatUrl();
  const assetType = splatTypeFromUrl(assetUrl);

  // Stream-fetch so the splash bar shows a real %. A 96 MB asset over a
  // 4G link takes 7+ seconds; the original indeterminate slide animation
  // makes that feel broken. Bytes are accumulated then handed to
  // SplatMesh via `fileBytes` (vs. letting the library fetch the URL),
  // which is the only way to surface byte-level progress.
  const fileBytes = await fetchWithProgress(assetUrl, (loaded, total) => {
    const mb = (loaded / (1024 * 1024)).toFixed(1);
    if (total > 0) {
      const totalMb = (total / (1024 * 1024)).toFixed(1);
      const pct     = Math.min(100, Math.round((100 * loaded) / total));
      setLoading(`Fetching splat · ${mb} / ${totalMb} MB · ${pct}%`);
    } else {
      setLoading(`Fetching splat · ${mb} MB`);
    }
    setLoadProgress(loaded, total);
  });

  // Sanity-check the payload before handing it to Spark — turns the
  // opaque "Invalid .splat file size" deep in the parser into a
  // diagnostic at the actual point of failure (e.g. Vite SPA-fallback
  // returning index.html for a stale URL, or a truncated download).
  // For .splat the size must be a multiple of 32; .spz / .ply have
  // their own header sniffing and skip this check.
  if (assetType === "splat" && fileBytes.length % 32 !== 0) {
    const headHex = Array.from(fileBytes.slice(0, 8))
      .map(b => b.toString(16).padStart(2, "0")).join(" ");
    const headAscii = Array.from(fileBytes.slice(0, 32))
      .map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : ".").join("");
    const looksLikeHtml = headAscii.toLowerCase().includes("<!doc")
                       || headAscii.toLowerCase().includes("<html");
    console.error(
      "[Splat] Bad payload for", assetUrl,
      "\n  bytes:", fileBytes.length, "(not divisible by 32)",
      "\n  head hex:", headHex,
      "\n  head ascii:", headAscii,
      looksLikeHtml ? "\n  ⚠ Looks like HTML — the dev server is probably falling back to index.html for a missing URL. Restart Vite / hard-refresh." : "",
    );
    throw new Error(
      looksLikeHtml
        ? `Splat URL returned HTML (likely a 404 SPA fallback). Check that ${assetUrl} exists in /public and restart the dev server.`
        : `Truncated splat: got ${fileBytes.length} bytes (not a multiple of 32).`,
    );
  }

  setLoading("Decoding splat…");
  const splatOpts = {
    fileBytes,
    fileName: assetUrl.split("/").pop(),
    fileType: assetType,
  };
  // (maxSplats GPU cap removed alongside the mobile-variant fork —
  //  per user direction "no reason to sacrifice detail for this
  //  optimization". Every device now renders the full PC splat at
  //  full resolution; the SPLAT_MAX_PHONE / SPLAT_MAX_TABLET constants
  //  remain defined above as dormant config in case a future opt-in
  //  re-introduces capping for memory-constrained devices.)

  const built = await createSplat(splatOpts);
  splat = built.splat;
  scene.add(splat);
  _hudRefs.splat = splat;
  sceneLayers.add({ mesh: splat, name: SPLAT_URL.split("/").pop(), isPrimary: true });

  // Wireframe sphere overlay for Effector Mode. Parented to splat so its
  // position can be copied straight from uniforms.maskCenter (already in
  // splat-local space) without any world-space conversion each frame.
  effectorMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 16),
    new THREE.MeshBasicMaterial({
      wireframe: true,
      transparent: true,
      opacity: 0.4,
      depthTest: false,
      depthWrite: false,
      color: 0x66ddff,
    }),
  );
  effectorMesh.frustumCulled = false;
  effectorMesh.renderOrder = 998;
  effectorMesh.visible = false;
  splat.add(effectorMesh);

  setLoading("Computing bounds…");

  const center = built.center;
  const size   = built.size;
  const radius = built.radius;

  // Reframe camera
  camera.position.copy(center).add(new THREE.Vector3(0, radius * 0.4, radius * 1.8));
  controls.target.copy(center);
  controls.update();

  // ---- Effects ----
  effects = new EffectController(splat);
  splat.objectModifier = createScanModifier();
  splat.updateGenerator();
  const gui = buildGUI(effects);
  window.__gui = gui;     // exposed so the floating About pill (and other
                          // promoted affordances) can mirror state into
                          // the lil-gui controllers that own canonical state
  postfx.attachGUI(gui);
  // Push lil-gui inward from the viewport edges so the panel doesn't
  // hug the right border (a little bleed reads more polished). Also
  // cap its height so it doesn't run all the way to the bottom edge.
  gui.domElement.style.top         = "18px";
  gui.domElement.style.right       = "18px";
  gui.domElement.style.maxHeight   = "calc(100vh - 36px)";

  // "Reset to default presentation" — single click that wipes the user's
  // toggle / slider explorations and snaps everything back to the curated
  // first-impression. Crucial after 5+ minutes of fiddling: today there's
  // no way home except a hard refresh (which also nukes user-created
  // viewpoints). This button keeps viewpoints + persisted prefs intact,
  // but rolls FX/post/scene-layer/visibility back to the defaults the
  // cinematic intro lands on.
  const resetBtn = document.createElement("button");
  resetBtn.className = "gui-reset-btn";
  resetBtn.type = "button";
  resetBtn.title = "Reset visual settings to the default presentation (keeps your viewpoints)";
  resetBtn.setAttribute("aria-label", "Reset to default presentation");
  resetBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="1 4 1 10 7 10"/>
      <path d="M3.51 15A9 9 0 1 0 6 5.3L1 10"/>
    </svg>
    <span>Reset</span>
  `;
  resetBtn.addEventListener("click", () => {
    // 1. Re-apply the default FX preset (snaps Effect + Color + Radius + …)
    try {
      const DEFAULT_FX = "Slime Molds";
      gui.controllersRecursive().forEach(c => {
        if (c._name === "Preset" && typeof c.setValue === "function") {
          c.setValue(DEFAULT_FX);
        }
      });
    } catch {}
    // 2. Reset post-fx params to module defaults via the GUI controllers'
    //    .reset() (each lil-gui controller knows its initial value).
    try {
      gui.controllersRecursive().forEach(c => {
        if (typeof c.reset === "function") c.reset();
      });
    } catch {}
    // 3. All splat layers visible (Scene panel eyes back ON)
    try {
      sceneLayers.layers.forEach(l => { if (!l.visible) sceneLayers.setVisible(l.id, true); });
    } catch {}
    // 4. Status confirmation
    if (typeof statusEl !== "undefined") statusEl.textContent = "Reset to default presentation";
  });
  // "↻ Replay intro" — promotes the cinematic re-play out of the deeply
  // nested Cinematic-FX folder into the always-visible panel title row.
  // Sits NEXT TO Reset because both are "global, one-click, big action"
  // affordances — Reset wipes state, Replay re-fires the directed camera
  // move. They're not viewpoints (Viewpoints sidebar earlier was the wrong
  // home — user feedback: "这个按钮放在这里不合适，因为不是viewport"),
  // they're meta-actions affecting the whole experience.
  const replayBtn = document.createElement("button");
  replayBtn.className = "gui-reset-btn gui-replay-btn";
  replayBtn.type = "button";
  replayBtn.title = "Replay the opening cinematic camera move";
  replayBtn.setAttribute("aria-label", "Replay cinematic intro");
  replayBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polygon points="6 4 20 12 6 20 6 4"/>
    </svg>
    <span>Replay</span>
  `;
  replayBtn.addEventListener("click", () => {
    if (typeof window.__replayIntro !== "function") {
      statusEl.textContent = "Cinematic still loading, try again in a moment";
      return;
    }
    // Half-second fade-to-black before the page reload. __replayIntro
    // clears the first-visit flag and reloads, which without a fade
    // reads as a jarring yank — the half-second darken makes the cut
    // feel deliberate, like a director's wipe. CSS rule on
    // `body.replay-fading::after` owns the actual animation.
    document.body.classList.add("replay-fading");
    setTimeout(() => window.__replayIntro(), 480);
  });

  // "Snap" — PNG snapshot of the current canvas. Sits between Replay
  // and Reset because, narratively, it's the third member of the
  // "global one-click" group: Replay sells the scene, Snap captures
  // it, Reset clears the slate. toDataURL() reads the WebGL backbuffer
  // — we have to force a fresh draw immediately before reading so the
  // capture matches what's on screen right now (the renderer's
  // backbuffer is normally already consumed by composition; calling
  // render() once with preserveDrawingBuffer-equivalent semantics via
  // the existing renderer instance keeps the readback in sync).
  const snapBtn = document.createElement("button");
  snapBtn.className = "gui-reset-btn gui-snap-btn";
  snapBtn.type = "button";
  snapBtn.title = "Save a PNG snapshot of the current view";
  snapBtn.setAttribute("aria-label", "Save snapshot");
  snapBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 7h2l2-3h6l2 3h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/>
      <circle cx="12" cy="13" r="4"/>
    </svg>
    <span>Snap</span>
  `;
  snapBtn.addEventListener("click", () => {
    if (typeof window.__captureSnapshot === "function") window.__captureSnapshot();
  });

  // Insert all three global-action pills into the lil-gui title row, in
  // order: Replay (the affirmative "play me") · Snap (the keepsake) ·
  // Reset (the corrective "undo my fiddling"). The common user intent —
  // re-watching the cinematic — stays closest to the eye, and the
  // destructive action sits at the far right.
  const titleEl = gui.domElement.querySelector(".title");
  if (titleEl) {
    titleEl.appendChild(replayBtn);
    titleEl.appendChild(snapBtn);
    titleEl.appendChild(resetBtn);
  }
  // Top-level "Cinematic FX" — promotes the character-defining post-FX
  // (Lens Distortion / Underwater / Kaleidoscope) out of the colour-grading
  // Post-Process folder so they're immediately discoverable. The Particles
  // toggle is mirrored in here later once gpgpuParticles is built (see the
  // particles section below).
  const fCine = gui.addFolder("Cinematic FX");
  postfx.attachFeaturedFX(fCine);
  gui.fCine = fCine;
  // Phone (any orientation): auto-collapse every folder so the panel
  // doesn't eat the short viewport. The previous gate (IS_MOBILE === IS_PHONE)
  // was sticky from init-time portrait detection and missed phone-LANDSCAPE
  // sessions — user report: "手机端只能显示一部分" (the phone version only
  // shows a portion). Querying the live `phone-device` body class instead
  // means the rule fires whether the phone is held portrait or landscape.
  // iPad is intentionally excluded (room to breathe + power-user device).
  // We also default-close the GUI itself on phone-portrait (mobile=phone in
  // portrait), preserving the original behavior where the user taps the
  // collapsed pill to open the rail.
  if (document.body.classList.contains("phone-device")) {
    gui.foldersRecursive().forEach(f => f.close());
    if (IS_MOBILE) gui.close();   // portrait — collapse the whole pill too
  }
  // Touch: tap outside the panel collapses it. The panel covers ~half the
  // phone viewport when open, so the user expects "tap the scene to get
  // back to the splat" — like an iOS sheet. We whitelist the other UI
  // panels so their own outside-click handlers can run; everything else
  // (the canvas, the splash, the annotation layer) closes the GUI.
  // PHONE-only: on tablet the lil-gui is the canonical entry point
  // (same as desktop) so we keep its standard click-to-collapse-title
  // behavior intact.
  if (IS_PHONE) {
    document.addEventListener("pointerdown", (e) => {
      if (gui._closed) return;
      const t = e.target;
      if (gui.domElement.contains(t)) return;
      // Don't fight modal-ish panels that handle their own dismissal.
      if (t?.closest?.("#mobile-nav-btn, #mobile-nav-menu, #mobile-bottombar, #mobile-sheet, #mobile-sheet-backdrop, #mobile-toast, #key-hints, #credits, #profiler, #tech-spec, #asset-hover-card, #usd-annotations, .ah-tip-portal, dialog")) return;
      gui.close();
    }, true);
  }

  // ---- Voxelizer + Quadizer (USD PointInstancer-style overlays) -----------
  // Voxelizer: instanced cubes (BoxGeometry) aggregating splats into a grid.
  // Quadizer:  one camera-facing billboard per splat, reading vertex color.
  // Both pull in the shared effect uniforms so click FX animates them too.
  voxelizer = new Voxelizer({
    scene, splatMesh: splat,
    voxelSize: effectUniforms.voxelSize.value,
    shape:     effectParams.voxelShape,
    fxUniforms: effectUniforms,
  });
  quadizer = new Quadizer({
    scene, splatMesh: splat,
    quadSize: effectUniforms.quadSize.value,
    shape:    effectParams.quadShape,
    fxUniforms: effectUniforms,
  });
  // Pre-warm the Quadizer so the ¼-beat of the auto-played intro (when
  // setLayerVis("quad", true) lands) doesn't trigger the synchronous
  // ~3M-splat rebuild + first-frame shader compile + GPU buffer upload
  // all on one frame — that combo produced a visible ~150 ms stutter at
  // the 4.21 s mark. Done after a short delay so the splat-load critical
  // path finishes first; the work overlaps the splash-fade choreography.
  // Uses renderer.compile(scene, camera) to force the shader+buffer
  // upload WITHOUT actually drawing a frame, so there's no visible flash
  // of the quad layer at near-zero opacity.
  setTimeout(() => {
    if (!quadizer) return;
    quadizer.rebuild();
    if (quadizer.mesh && renderer?.compile) {
      quadizer.mesh.visible = true;       // include the mesh in compile() walk
      try { renderer.compile(scene, camera); } catch (e) { console.warn("[Quadizer pre-warm compile]", e); }
      // Hard-reset to invisible: the per-frame quadizer.setOpacity(quadVis)
      // call will continue to drive this from the lerped uniform, so the
      // ¼-beat opacity ramp still kicks in normally.
      quadizer.mesh.visible = false;
    }
  }, 400);
  _hudRefs.voxelizer = voxelizer;
  _hudRefs.quadizer  = quadizer;
  // LOCAL PAPER-VALIDATION TOOL — console-only USD PointInstancer export.
  // Usage: __exportUSD("voxel") / __exportUSD("billboard", { stride: 10 }).
  // Lazy import keeps the exporter out of the production bundle path.
  window.__exportUSD = (layer = "voxel", opts = {}) => {
    import("./usd-export.js").then(m =>
      m.exportLayerUSDA(layer, { voxelizer, quadizer, ...opts })
    );
  };
  gui.controllersRecursive().forEach(ctrl => {
    if (ctrl._name === "Voxel Size") {
      const prev = ctrl._onChange;
      ctrl.onChange((v) => { if (prev) prev(v); voxelizer.setVoxelSize(v); });
    } else if (ctrl._name === "Quad Size") {
      const prev = ctrl._onChange;
      ctrl.onChange((v) => { if (prev) prev(v); quadizer.setQuadSize(v); });
    }
  });
  // Quad/Circle and Cube/Sphere segmented buttons are raw DOM (not lil-gui
  // controllers), so effects.js dispatches their clicks through this hook.
  gui.__shapeCallbacks = {
    quad:  (v) => quadizer?.setShape(v),
    voxel: (v) => voxelizer?.setShape(v),
  };

  // 3DGS / USD panel — eye-icon-driven layer list (matches the Scene panel
  // visual language). Replaces the lil-gui "3DGS/USD" folder, which we
  // hide below so the two surfaces don't double up on the same toggles.
  // Mounted on <body> (not #left-stack) and positioned via CSS at the
  // Render HUD's old slot in the top-left rail.
  // Museum-style annotation overlay; fires from a manual eye toggle only
  // (camera-move's programmatic setLayerVis calls bypass UsdLayers).
  const usdAnnotations = new UsdAnnotations({ mountEl: document.body });
  window.__usdAnnotations = usdAnnotations;

  // Mount UsdLayers as the content of a REAL lil-gui folder named
  // "3DGS / USD". This is the structural fix for the hierarchy issue:
  // a custom panel sibling-of-folders never quite matched lil-gui's
  // own folder visuals (caret style, title weight, indentation, fold
  // animation). Putting our content inside a real folder means the
  // sibling row IS a real lil-gui folder, identical to Customize /
  // Cinematic FX / Tech Spec / Camera Movement. The .usd-embedded
  // class strips our panel's own chrome (background / border) so
  // only the folder's own treatment shows.
  const guiChildren = gui.domElement.querySelector(".children");
  const fUsd = gui.addFolder("3DGS / USD");
  // Move the new folder to be the FIRST child of the root so it sits
  // at the top of PlaySplat Studio (its showcase position).
  if (guiChildren && fUsd?.domElement) {
    guiChildren.insertBefore(fUsd.domElement, guiChildren.firstChild);
  }
  const fUsdChildren = fUsd.domElement.querySelector(".children");
  const usdLayers = new UsdLayers({
    mountEl:      fUsdChildren || document.body,
    params:       effectParams,
    controller:   effects,
    onQuadShape:  (v) => quadizer?.setShape(v),
    onVoxelShape: (v) => voxelizer?.setShape(v),
    onQuadSize:   (v) => quadizer?.setQuadSize(v),
    onVoxelSize:  (v) => voxelizer?.setVoxelSize(v),
    // showSplatDrop is defined later in loadSplat — resolve lazily via
    // the window stash that gets set when it's ready (search this file
    // for window.__showSplatDrop).
    onUploadRequest: () => window.__showSplatDrop?.(),
    onLayerActivate: (key) => usdAnnotations.show(key),
  });
  if (fUsdChildren) usdLayers.el.classList.add("usd-embedded");
  window.__usdLayers = usdLayers;

  // ---- Playbar (progressive disclosure over the Studio panel) ------------
  // Desktop-only outcome-first bar: representation switcher + effect chips
  // + Tour + Studio toggle. On touch the mobile bottom-bar already covers
  // this role, so the bar is CSS-hidden under body.touch and the gui keeps
  // its current behaviour there. On desktop the gui starts hidden — the
  // STUDIO button restores the full expert surface with all state intact.
  const playbar = new Playbar({ gui, params: effectParams });
  window.__playbar = playbar;
  if (!document.body.classList.contains("touch") && window.innerWidth >= 900) {
    gui.hide();
  }
  if (gui.fLayers?.hide) gui.fLayers.hide();

  // ---- Annotations ----
  annotations = new AnnotationManager({
    camera,
    controls,
    layerEl: annoLayer,
    listEl: viewList,
    addBtnEl: addBtn,
    statusEl,
    // localStorage key scoped to the splat URL so swapping splats doesn't
    // bring along the wrong viewpoints.
    // v11 — generic (bbox-derived) viewpoints for non-authored scenes; bump
    // evicts stale cached copies that still held the garden-only poses.
    storageKey: "playsplat:viewpoints:v11:" + SPLAT_URL,
  });
  // Seed defaults silently — without this guard, each seeded add() would
  // write to localStorage and wipe any saved user-added viewpoints (e.g.
  // "Gazebo") before we get a chance to read them. Generic scenes (train,
  // user drops) get bbox-framed viewpoints instead of the garden's
  // hand-tuned gazebo poses, which would otherwise bury the camera.
  annotations._suspendSave = true;
  const centerVp = annotations.seedDefaults(center, radius, { generic: !SCENE.authored });
  annotations._suspendSave = false;

  // Asset hotspot click → tween the camera close to the asset. Same Z-flip
  // as the hotspot projection so the camera lands on the visible asset
  // (not its source-tool mirror across the origin).
  assetHover.onAssetSelect = (it) => {
    if (!Array.isArray(it.worldPos)) return;
    const target   = new THREE.Vector3(it.worldPos[0], it.worldPos[1], -it.worldPos[2]);
    const position = target.clone().add(new THREE.Vector3(0, 0.5, 1.5));
    annotations.flyToPose(position, target);
  };
  // If localStorage has saved viewpoints (e.g. the user's custom "Gazebo"
  // viewpoint added in a previous session), replace the seeded defaults
  // with them. Auto-save on add/remove/rename keeps storage in sync going
  // forward, so any new viewpoint persists automatically.
  const restored = annotations.restoreFromStorage();
  if (!restored) annotations._save();   // first run: persist the defaults
  // Default viewpoint = Center (#6) — landing pose is the COLMAP cam #582
  // framing patched in by the COLMAP loader. Falls back to the first
  // available viewpoint if Center somehow isn't present.
  const activeVp =
    annotations.viewpoints.find(v => v.name === "Center")
    || annotations.viewpoints[0]
    || centerVp;
  if (activeVp) {
    annotations.activeId = activeVp.id;
    annotations._rebuildList();
    camera.position.copy(activeVp.position);
    controls.target.copy(activeVp.target);
    controls.update();
  }

  // ---- Deep-link viewpoint via URL hash -----------------------------------
  // Format: #v=px,py,pz,tx,ty,tz   (camera pos x/y/z + target x/y/z)
  // If present at load, wins over the default landing viewpoint and flies
  // the camera to the encoded pose. A "Copy link" action (added to the
  // Viewpoints panel below) generates the hash from the current camera
  // pose so a presenter can email "here's the gazebo angle I love".
  function _parseViewHash() {
    const m = (location.hash || "").match(/#v=([-\d.,eE]+)/);
    if (!m) return null;
    const nums = m[1].split(",").map(parseFloat);
    if (nums.length !== 6 || nums.some(n => !Number.isFinite(n))) return null;
    return {
      position: new THREE.Vector3(nums[0], nums[1], nums[2]),
      target:   new THREE.Vector3(nums[3], nums[4], nums[5]),
    };
  }
  const _deepLinkPose = _parseViewHash();
  if (_deepLinkPose) {
    // Apply immediately AND flag so the auto-cinematic-intro defers to
    // the explicit link (the user clearly wanted this specific view, not
    // the canned opening shot).
    camera.position.copy(_deepLinkPose.position);
    controls.target.copy(_deepLinkPose.target);
    controls.update();
    window.__deepLinkLanded = true;
  }

  // ---- Deep-link Tech Breakdown asset via URL hash -----------------------
  // Format: #asset=Foliage   (case-insensitive; spaces preserved)
  // Co-exists with #v=... — the two are combined with `&`, e.g.
  // `#v=1,2,3,4,5,6&asset=Foliage` opens the drawer to Foliage AFTER the
  // camera lands at the requested pose. Empty / unknown asset names
  // silently no-op so a stale link doesn't break the boot.
  function _parseAssetHash() {
    const m = (location.hash || "").match(/[#&]asset=([^&]+)/i);
    if (!m) return null;
    try { return decodeURIComponent(m[1]).trim(); }
    catch { return null; }
  }
  const _deepLinkAsset = _parseAssetHash();
  if (_deepLinkAsset) {
    // Defer the drawer open by one rAF so it lands AFTER the UI choreography
    // has settled (otherwise the entrance animations fight the auto-scroll).
    requestAnimationFrame(() => {
      try { techSpec.openToAsset(_deepLinkAsset); }
      catch (err) { console.warn("Asset deep-link failed:", err); }
    });
  }
  // Expose a helper any UI can call to copy the current pose as a share link.
  window.__copyViewLink = async function _copyViewLink() {
    const p = camera.position, t = controls.target;
    const fmt = (n) => Number(n).toFixed(3);
    const hash = `#v=${fmt(p.x)},${fmt(p.y)},${fmt(p.z)},${fmt(t.x)},${fmt(t.y)},${fmt(t.z)}`;
    const url  = location.origin + location.pathname + location.search + hash;
    try {
      await navigator.clipboard.writeText(url);
      statusEl.textContent = "Link copied. Paste to share this exact viewpoint";
    } catch {
      // Fallback for non-secure contexts or denied clipboard permission:
      // shove it in the address bar so the user can copy manually.
      history.replaceState(null, "", hash);
      statusEl.textContent = "Link updated in address bar. Copy from there";
    }
  };

  // Viewport Tuner — press K to open; shows live pose + lets you commit
  // the current camera state into any seeded viewpoint slot. Skipped on
  // PHONE only (no physical K key, narrow viewport, panel hidden via
  // CSS); iPad gets the full desktop tuner since it has the screen for
  // it and can pair a Bluetooth keyboard.
  if (!IS_PHONE) {
    viewpointTuner = new ViewpointTuner({
      mountEl: document.getElementById("app") || document.body,
      camera,
      controls,
      annotations,
    });
    window.__viewpointTuner = viewpointTuner;
  }

  // Mobile bottom-bar + slide-up sheet. Replaces the scattered corner
  // panels with a one-thumb-friendly bottom-up layout. Built only on
  // PHONE (not tablet — iPad gets the desktop UI per project direction).
  // Constructed after annotations so the Views sheet has its viewpoint
  // list, and after assetHover so the short-tap / long-press hooks
  // attach. The camera-move handles (window.__camMovePlayPause /
  // __camMoveStop) are resolved lazily at click time, so it's fine that
  // they don't exist yet.
  let mobileUI = null;
  if (IS_PHONE) {
    mobileUI = new MobileUI({
      annotations,
      gui,
      effectParams,
      effects,
      postfx,
      assetHover,
      splat,
      usdLayers,           // floating Studio panel re-parents this DOM
    });
    window.__mobileUI = mobileUI;
  }

  // ---- Data-label surveillance overlay (sits over the canvas) ----
  dataLabels = new DataLabelLayer({
    canvas,
    camera,
    annotationManager: annotations,
    appEl: document.getElementById("app"),
  });
  dataLabels.setBounds(center, size);

  // ---- Hover tooltip for camera frustums -----------------------------------
  // Manual ray-vs-point pick (cheap for ~150 cameras) — projects each frustum
  // origin to NDC and picks the closest within the line-segment hit radius.
  function installFrustumHover(frustumMesh) {
    const data       = frustumMesh.userData.frustums || [];
    const pickRadius = frustumMesh.userData.pickRadius ?? 0.05;

    const tip = document.createElement("div");
    tip.className = "frustum-tip";
    tip.style.display = "none";
    document.getElementById("app").appendChild(tip);

    const _pv = new THREE.Vector3();
    let lastHover = -1;

    canvas.addEventListener("pointermove", (e) => {
      if (!frustumMesh.visible) {
        if (tip.style.display !== "none") tip.style.display = "none";
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Pick the frustum whose origin projects closest to the cursor in screen
      // space (within the per-frustum hit radius converted to px).
      let bestI = -1, bestPx = Infinity;
      const w = rect.width, h = rect.height;
      for (let i = 0; i < data.length; i++) {
        _pv.copy(data[i].pos).project(camera);
        if (_pv.z > 1) continue;                 // behind camera
        const sx = ( _pv.x * 0.5 + 0.5) * w;
        const sy = (-_pv.y * 0.5 + 0.5) * h;
        const dx = sx - mx, dy = sy - my;
        const d  = Math.hypot(dx, dy);
        if (d < bestPx) { bestPx = d; bestI = i; }
      }

      // Convert pickRadius (world units) at the picked depth → px so the hit
      // area scales with distance (close frustums easier to hit than far).
      const HIT_PX = 14;
      if (bestI >= 0 && bestPx < HIT_PX) {
        if (bestI !== lastHover) {
          const d = data[bestI];
          const f = (n, p = 3) => Number(n).toFixed(p);
          const [qw, qx, qy, qz] = d.qRaw;

          tip.innerHTML =
            `<div class="k">CAM_ID</div><div class="v">#${d.cameraId}</div>` +
            `<div class="k">POS</div><div class="v">${f(d.pos.x, 2)}, ${f(d.pos.y, 2)}, ${f(d.pos.z, 2)}</div>` +
            `<div class="k">QUAT</div><div class="v">${f(qw)}, ${f(qx)}, ${f(qy)}, ${f(qz)}</div>`;
          lastHover = bestI;
        }
        tip.style.display = "block";
        tip.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
      } else {
        if (tip.style.display !== "none") tip.style.display = "none";
        lastHover = -1;
      }
    });

    canvas.addEventListener("pointerleave", () => {
      tip.style.display = "none";
      lastHover = -1;
    });
  }

  // ---- COLMAP capture poses → data-label ticks -----------------------------
  // The .bin files in public/colmap/ are the COLMAP reconstruction the splat
  // was trained from. Each entry in images.bin gives a real camera world
  // position; we use those as the ambient ticks instead of random points so
  // the surveillance overlay shows the actual capture path.
  //
  // Coordinate alignment: the splat mesh is rotated 180° around X to bring
  // Postshot's Y-down convention into Three.js's Y-up. We apply the same
  // mirror to the COLMAP positions so they sit in the same world frame.
  // Only the authored scene ships a matching COLMAP reconstruction; a
  // generic scene would either 404 or, worse, display the garden's 990
  // capture poses floating in unrelated coordinates. Skip it entirely.
  if (SCENE.authored)
  loadColmapImages(`${BASE}colmap/images.bin`)
    .then(images => {
      // Subsample for a less-cluttered overlay (target ~150 frustums).
      const TARGET = 150;
      const stride = Math.max(1, Math.floor(images.length / TARGET));
      const sampled = images.filter((_, i) => i % stride === 0);
      cameraFrustums = buildColmapFrustums(sampled, {
        size:  Math.max(0.015, radius * 0.0018),
        depth: Math.max(0.03,  radius * 0.0035),
      });
      // Lift the frustum cluster +0.6 unit on world-Y so the icons
      // visibly orbit ABOVE the splat's gazebo silhouette rather than
      // grazing it. Per user pick — was +1 initially, nudged down 0.4
      // because that read too high relative to the gazebo cornice.
      cameraFrustums.position.y += 0.6;
      cameraFrustums.visible = false;
      // Training cameras live in a SEPARATE scene rendered AFTER the
      // composer (same pattern as gpgpu particles), so they're not bloomed,
      // painterly'd, underwater'd, or smeared by Echo trails. The overlay
      // renders with depthTest=false (already set in colmap-loader) on top
      // of the composed frame.
      techOverlayScene.add(cameraFrustums);
      installFrustumHover(cameraFrustums);

      // ----- Tighter bbox for the data-label overlay --------------------
      // SplatMesh.getBoundingBox() gets blown out by outlier splats, so the
      // dashed bbox ends up far larger than the visible content. The COLMAP
      // training cameras orbit the actual subject, so their world-space
      // bounding box (slightly inset) is a much better proxy for "where the
      // interesting content lives". We rebuild the overlay using that.
      if (dataLabels && cameraFrustums.userData?.frustums?.length) {
        const colBox = new THREE.Box3();
        for (const f of cameraFrustums.userData.frustums) colBox.expandByPoint(f.pos);
        const colCenter = new THREE.Vector3(); colBox.getCenter(colCenter);
        const colSize   = new THREE.Vector3(); colBox.getSize(colSize);
        // Cameras sit OUTSIDE the subject by definition, so 0.6× their
        // spread is a tighter fit to what the viewer actually sees.
        colSize.multiplyScalar(0.6);
        dataLabels.setBounds(colCenter, colSize);
      }

      console.info(`[COLMAP] ${images.length} poses → ${sampled.length} frustums`);

      // ----- Center viewpoint = COLMAP capture cam #582 -----------------
      // The artist picked frame #582 as the canonical "centered on subject"
      // pose. Find it in the full (non-subsampled) image set, mirror the
      // 180° X flip the splat mesh + frustums already use, and patch the
      // Center viewpoint with that camera's position + forward look.
      const TARGET_CAM_ID = 582;
      const cam582 =
        images.find(im => im.imageId === TARGET_CAM_ID) ||
        images[TARGET_CAM_ID - 1] ||
        images[TARGET_CAM_ID];
      const centerVpRef = annotations?.viewpoints.find(v => v.name === "Center");
      if (cam582 && centerVpRef) {
        const camPos = colmapCameraPosition(cam582);
        const camRot = colmapCameraRotation(cam582);
        camPos.y = -camPos.y;            // same flipX180 as buildColmapFrustums
        camPos.z = -camPos.z;
        camRot.premultiply(new THREE.Quaternion(1, 0, 0, 0));
        // COLMAP camera looks down +Z in camera space — push the target
        // ahead by ~1.5 m so OrbitControls has a sane orbit radius.
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(camRot);
        const camTgt = camPos.clone().add(fwd.multiplyScalar(1.5));
        centerVpRef.position.copy(camPos);
        centerVpRef.target.copy(camTgt);
        if (annotations.activeId === centerVpRef.id) {
          camera.position.copy(camPos);
          controls.target.copy(camTgt);
          controls.update();
        }
        console.info(`[COLMAP] Center viewpoint patched to cam #${TARGET_CAM_ID}`);
      } else {
        console.warn(`[COLMAP] cam #${TARGET_CAM_ID} not found — Center keeps seed default`);
      }
    })
    .catch(err => {
      console.warn("[COLMAP] failed to load:", err?.message ?? err);
    });

  // ---- Tech Spec — split out from Overlays --------------------------------
  // Master Enable controls the ASSET HOTSPOT layer (vine / gazebo / grape /
  // daffodil — the dots floating on the splat). Training Cameras and Data
  // Labels are independent sub-toggles so they stay off at startup even
  // when Enable is on. Future tech-breakdown rows (AI Stylization / VAT
  // Anim / GPU / Postshot Pipeline) will sit under the same parent.
  const dataParams = { enabled: false, dataLabels: false };
  const techParams = { techEnable: true, credits: false };
  const fTechSpec = gui.addFolder("Tech Spec");
  const techEnableCtrl = fTechSpec.add(techParams, "techEnable").name("Enable").onChange((v) => {
    // Asset hotspot layer is the only thing the master gates now.
    window.__techEnableValue = !!v;
    if (assetHover) assetHover.setVisible(!!v);
  });
  // Seed the initial value so the scene-visibility callback can read it
  // on first paint (before the user has clicked anything).
  window.__techEnableValue = techParams.techEnable;
  techEnableCtrl.domElement.title = "Show / hide the floating asset hotspots (Vine / Gazebo / Grape Hyacinth / Daffodil) on the splat.";

  const camCtrl = fTechSpec.add(dataParams, "enabled").name("Training Cameras").onChange(v => {
    window.__camFrustumsUserOn = !!v;
    if (cameraFrustums) cameraFrustums.visible = !!v;
  });
  // Postshot-style: small wireframe pyramid icon next to the label.
  const camIcon = `<svg class="ctrl-icon" viewBox="0 0 24 16" aria-hidden="true">
    <polygon points="2,8 18,2 18,14" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>
    <polygon points="18,2 22,4 22,12 18,14" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>
    <line x1="2" y1="8" x2="22" y2="4" stroke="currentColor" stroke-width="1.1"/>
    <line x1="2" y1="8" x2="22" y2="12" stroke="currentColor" stroke-width="1.1"/>
  </svg>`;
  const nameEl = camCtrl.domElement.querySelector(".name");
  if (nameEl) nameEl.insertAdjacentHTML("afterbegin", camIcon);
  camCtrl.domElement.title = "Lets you toggle whether training camera poses are shown in the viewport.";

  const dataLabelsCtrl = fTechSpec.add(dataParams, "dataLabels").name("Data Labels").onChange(v => {
    window.__dataLabelsUserOn = !!v;
    if (dataLabels) dataLabels.setEnabled(!!v);
  });
  dataLabelsCtrl.domElement.title = "Surveillance-card overlay showing per-viewpoint metadata.";

  // Credits — names + software stack. Lives in its own floating panel so
  // it doesn't compete with the Pipeline drawer for the right edge.
  const creditsCtrl = fTechSpec.add(techParams, "credits").name("Credits").onChange(v => {
    credits.setOpen(!!v);
  });
  creditsCtrl.domElement.title = "Show the team + software credits for this showcase.";
  // Keep the lil-gui checkbox in sync if the user closes the panel via ×.
  credits.onOpenChange = (open) => {
    if (techParams.credits !== open) {
      techParams.credits = open;
      creditsCtrl.updateDisplay();
    }
  };
  // TEMPORARILY DELISTED — the Tech Spec drawer (and its Credits entry)
  // are hidden while the PlaySplat-specific breakdown content is being
  // rewritten. Remove this hide() to restore the folder.
  fTechSpec.hide();

  // Replay Intro — clears the first-visit flag and reloads so the camera
  // move auto-plays again, with the title-sequence overlay, onboarding
  // pointers, and Quad-popup auto-pop running fresh as if it were the
  // user's first time on the site. Exposed on window so the mobile-nav
  // drawer can also trigger it. The lil-gui button itself is mounted
  // further down inside the "Camera Movement" folder — it lives with
  // Play / Stop because that's the user's mental model for "do the
  // camera-move thing again", not in Tech Spec.
  window.__replayIntro = () => {
    // Authored scene: clear the first-visit flag and reload so the FBX
    // cinematic + title overlay auto-play fresh. A generic scene has no
    // authored cinematic, so "replay" instead plays the procedural orbit
    // tour around the current scene (a reload would just land back in the
    // static interactive view, which read as "replay does nothing").
    if (!SCENE.authored) {
      window.__tourToggle?.();
      return;
    }
    try { localStorage.removeItem("playsplat:visited:v1"); } catch {}
    window.location.reload();
  };

  // Pipeline drawer is intentionally decoupled from Tech Spec Enable now.
  // The asset hotspots are on by default and the drawer is pure asset
  // documentation — flipping one shouldn't toggle the other.

  // ---- HDR sky folder (inside Customize) ---------------------------------
  // Loads /Skybox.hdr lazily on first activation, applies as scene.background
  // + scene.environment. Most visible when the splat is rendered as points
  // so the sky shows through; available in Gaussian mode too.
  //
  // Folder mirrors the Post-Process shape: an Enable checkbox, a Rotation
  // slider (0-360°, mapped to scene.backgroundRotation.y and
  // scene.environmentRotation.y), and the "Use My Own HDRI" button.
  const fOverlay = gui.addFolder("Camera Movement");   // renamed from "Overlays"
  let hdrTex = null;
  let hdrLoading = false;
  const hdrParams = { hdr: false, rotation: 0 };
  const hdrParent = gui.fCustomize || fOverlay;
  const fHdr = hdrParent.addFolder("HDR Sky").close();

  // Ensure scene.backgroundRotation / environmentRotation Eulers exist
  // (Three.js r158+ initialises them, but guard for safety).
  scene.backgroundRotation  = scene.backgroundRotation  || new THREE.Euler();
  scene.environmentRotation = scene.environmentRotation || new THREE.Euler();

  const applyHdrRotation = (deg) => {
    const rad = deg * Math.PI / 180;
    scene.backgroundRotation.y  = rad;
    scene.environmentRotation.y = rad;
  };

  const hdrCtrl = fHdr.add(hdrParams, "hdr").name("Enable").onChange(async (v) => {
    if (v) {
      if (!hdrTex && !hdrLoading) {
        hdrLoading = true;
        try {
          const tex = await new RGBELoader().loadAsync(`${BASE}Skybox.hdr`);
          tex.mapping = THREE.EquirectangularReflectionMapping;
          hdrTex = tex;
        } catch (err) {
          console.warn("[HDR] failed to load:", err?.message ?? err);
          hdrParams.hdr = false;
          hdrCtrl.updateDisplay();
          hdrLoading = false;
          return;
        }
        hdrLoading = false;
      }
      if (hdrTex) {
        scene.background = hdrTex;
        scene.environment = hdrTex;
        applyHdrRotation(hdrParams.rotation);
      }
    } else {
      scene.background = null;
      scene.environment = null;
    }
  });
  hdrCtrl.domElement.title = "Show the HDR environment behind the splat — most visible in Point mode.";

  fHdr.add(hdrParams, "rotation", 0, 360, 1).name("Rotation")
    .onChange(applyHdrRotation);

  // ---- HDR drag-and-drop upload -------------------------------------------
  // "Use My Own HDRI" button opens a centred drop zone; drag any .hdr file
  // into it and it parses via RGBELoader.parse() (no fetch), replaces the
  // current environment, and turns HDR Sky on.
  const hdrDrop = document.createElement("div");
  hdrDrop.className = "hdri-drop";
  hdrDrop.innerHTML = `
    <div class="hdri-card">
      <div class="hdri-title">Drop your .hdr file</div>
      <div class="hdri-hint">Equirectangular HDRI · click anywhere outside to cancel</div>
      <div class="hdri-status"></div>
    </div>
  `;
  hdrDrop.style.display = "none";
  document.getElementById("app").appendChild(hdrDrop);
  const hdrStatusEl = hdrDrop.querySelector(".hdri-status");

  const showHdrDrop  = () => { hdrDrop.style.display = "flex"; hdrStatusEl.textContent = ""; };
  const hideHdrDrop  = () => { hdrDrop.style.display = "none"; };
  hdrDrop.addEventListener("click", (e) => { if (e.target === hdrDrop) hideHdrDrop(); });
  hdrDrop.addEventListener("dragover", (e) => { e.preventDefault(); hdrDrop.classList.add("over"); });
  hdrDrop.addEventListener("dragleave", () => hdrDrop.classList.remove("over"));
  hdrDrop.addEventListener("drop", async (e) => {
    e.preventDefault();
    hdrDrop.classList.remove("over");
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!/\.hdr$/i.test(file.name)) {
      hdrStatusEl.textContent = `Not an .hdr file: ${file.name}`;
      return;
    }
    hdrStatusEl.textContent = `Decoding ${file.name}…`;
    try {
      const buf = await file.arrayBuffer();
      const loader = new RGBELoader();
      const tex = loader.parse(buf);            // RGBELoader.parse → DataTexture
      tex.mapping = THREE.EquirectangularReflectionMapping;
      // Dispose previous if present
      if (hdrTex) hdrTex.dispose?.();
      hdrTex = tex;
      scene.background  = hdrTex;
      scene.environment = hdrTex;
      hdrParams.hdr     = true;
      hdrCtrl.updateDisplay();
      hdrStatusEl.textContent = `Loaded: ${file.name}`;
      setTimeout(hideHdrDrop, 600);
    } catch (err) {
      hdrStatusEl.textContent = "Decode failed: " + (err?.message ?? err);
    }
  });

  // "Use My Own HDRI" button — lives inside the HDR Sky folder alongside
  // Enable + Rotation so the entire HDR control surface is in one place.
  fHdr.add({ pick: showHdrDrop }, "pick").name("⤓ Use My Own HDRI");

  // ---- 3DGS drag-and-drop upload ------------------------------------------
  // "Use My Own 3DGS" button under 3DGS/USD opens a drop overlay; drag any
  // .splat / .ply / .spz / .ksplat file in → calls the existing
  // replaceSplatMesh() with the dropped bytes (no fetch, no extra UI).
  const splatDrop = document.createElement("div");
  splatDrop.className = "hdri-drop";
  splatDrop.innerHTML = `
    <div class="hdri-card">
      <div class="hdri-title">Drop your 3DGS asset</div>
      <div class="hdri-hint">.splat · .ply · .spz · .ksplat · click outside to cancel</div>
      <div class="hdri-status"></div>
    </div>
  `;
  splatDrop.style.display = "none";
  document.getElementById("app").appendChild(splatDrop);
  const splatStatusEl = splatDrop.querySelector(".hdri-status");

  // Native file picker for touch — drag-and-drop is a no-op on iPhone
  // and awkward on iPad. Triggers a hidden <input type="file">; the
  // user picks from Photos / Files / iCloud and we ingest the bytes
  // through the same replaceSplatMesh() path the drop handler uses.
  // The button tap propagates as a user gesture, which is what iOS
  // Safari requires to actually open the file picker.
  const pickSplatFile = () => {
    const input = document.createElement("input");
    input.type   = "file";
    input.accept = ".splat,.ply,.spz,.ksplat";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      if (!/\.(splat|ply|spz|ksplat)$/i.test(file.name)) {
        console.warn("[Splat] Unsupported file:", file.name);
        return;
      }
      try {
        const buf = await file.arrayBuffer();
        await replaceSplatMesh({ fileBytes: new Uint8Array(buf), fileName: file.name });
      } catch (err) {
        console.warn("[Splat] Failed to load picked file:", err);
      }
    });
    input.click();
  };

  const showSplatDrop = () => {
    // Phone has no drag — go straight to the native file picker.
    // iPad keeps the drop overlay since drag-and-drop works there.
    if (IS_PHONE) { pickSplatFile(); return; }
    splatDrop.style.display = "flex";
    splatStatusEl.textContent = "";
  };
  // Expose so the UsdLayers panel's "⤓ Use My Own" button (mounted
  // earlier) can call back into this drop-overlay flow.
  window.__showSplatDrop = showSplatDrop;
  const hideSplatDrop = () => { splatDrop.style.display = "none"; };
  splatDrop.addEventListener("click", (e) => { if (e.target === splatDrop) hideSplatDrop(); });
  splatDrop.addEventListener("dragover",  (e) => { e.preventDefault(); splatDrop.classList.add("over"); });
  splatDrop.addEventListener("dragleave", () => splatDrop.classList.remove("over"));
  splatDrop.addEventListener("drop", async (e) => {
    e.preventDefault();
    splatDrop.classList.remove("over");
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!/\.(splat|ply|spz|ksplat)$/i.test(file.name)) {
      splatStatusEl.textContent = `Unsupported file: ${file.name}`;
      return;
    }
    splatStatusEl.textContent = `Loading ${file.name}…`;
    try {
      const buf = await file.arrayBuffer();
      await replaceSplatMesh({ fileBytes: new Uint8Array(buf), fileName: file.name });
      splatStatusEl.textContent = `Loaded: ${file.name}`;
      setTimeout(hideSplatDrop, 600);
    } catch (err) {
      splatStatusEl.textContent = "Load failed: " + (err?.message ?? err);
    }
  });

  const splatParent = gui.fLayers || gui;
  splatParent.add({ pick: showSplatDrop }, "pick").name("⤓ Use My Own 3DGS");

  // ---- Pre-authored FBX camera move (Play / Pause / Stop) ------------------
  // Drives the scene camera off the animated FBX node every frame. Three
  // states: IDLE (time=0, controls enabled), PLAYING, PAUSED.
  let camFbxRoot = null, camMixer = null, camAction = null, camAnimNode = null;
  let camMoveLoading = false;
  let camMoveState = "idle";   // "idle" | "playing" | "paused"
  let camPhaseTimers = [];           // staged transition timers
  let camMovePrevSubform   = 0;      // restore on stop / finish
  let camMovePrevQuadVis   = 0;
  let camMovePrevQuadShape = null;   // "quad" | "circle"
  // Lens-stab state: a single short distortion sting at the very start
  // of the intro auto-play. Quick smoothstep rise, ease-out decay,
  // gone by tNorm = 0.05. Replaces the sustained-pulse attempts that
  // all felt wrong.
  let camMovePrevLensOn      = false;
  let camMovePrevLensFisheye = 0;
  let camMovePrevLensSqueeze = 1;
  let camMovePrevLensAmt     = 0;
  let camMovePrevPostEnable  = true;
  let _introLensActive       = false;     // currently inside the stab window
  let _introTouchedLens      = false;     // ever fired during this play
  // Lens outro fade: when the cinematic ends, lerp every distortion param
  // toward fully neutral values (no warp, no squeeze, no chromatic shift)
  // over INTRO_LENS_FADE_MS, then disable the pass. The pre-intro defaults
  // are themselves distorting (lensAmt = -1, lensSqueeze = 0.97 …), so
  // restoring them produces a visible "snap" at the seam — fading to
  // genuinely neutral values is what removes the distortion smoothly.
  // 0 = no fade in progress.
  let _introLensFadeStart    = 0;
  let _introLensFadeFrom     = {
    lensFisheye: 0, lensAmt: 0, lensZoom: 1,
    lensDispersion: 0, lensSqueeze: 1,
  };
  const INTRO_LENS_FADE_MS   = 1800;
  // The fade target — geometric / chromatic identity. Independent of the
  // user's pre-intro lens state on purpose: the user explicitly asked the
  // post-intro state to read as "no lens distortion at all".
  const NEUTRAL_LENS = {
    lensFisheye:   0.0,
    lensAmt:       0.0,
    lensZoom:      1.0,
    lensDispersion: 0.0,
    lensSqueeze:   1.0,
  };
  // Cinematic preset — what the lens params should snap back to after
  // the intro outro completes, so that if the user later re-enables
  // Lens Distortion in the GUI it produces the *intended* look (not the
  // identity / zeroed state the outro fades to visually). The fade
  // itself still goes to NEUTRAL_LENS visually; we only restore these
  // values once lensOn flips off (the effect is no longer rendering,
  // so the snap is invisible).
  const LENS_DEFAULTS = {
    lensFisheye:   0.04,
    lensAmt:       -1.0,
    lensZoom:      0.95,
    lensDispersion: 0.01,
    lensSqueeze:   0.97,
  };
  let camMovePrevCamFrustumsVisible = false;  // Training Cameras restore
  let camMovePrevCamFrustumsOpacity = 0.85;
  let _introFrustumsOn      = false;          // intra-tick edge detect
  let _introTouchedFrustums = false;          // ever toggled during intro?
  // No more tail-ease — the previous 0.10x dt slowdown was perceived as a
  // stutter ("顿了一下") rather than a smooth deceleration. Let the FBX
  // run at its authored speed; the Houdini camera's own end-of-clip
  // motion is what the viewer should see.
  const _camFwd = new THREE.Vector3();

  // Timeline / frame readout — visible only while the camera move is loaded.
  const CAM_FPS = 24;
  const camTimeline = document.createElement("div");
  camTimeline.className = "cam-timeline";
  camTimeline.innerHTML = `
    <div class="ct-row">
      <span class="ct-label">CAMERA MOVE</span>
      <span class="ct-time">0 / 0</span>
      <span class="ct-frame">0 / 0</span>
    </div>
    <div class="ct-bar"><div class="ct-fill"></div></div>
  `;
  camTimeline.style.display = "none";
  document.getElementById("app").appendChild(camTimeline);
  const ctTimeEl  = camTimeline.querySelector(".ct-time");
  const ctFrameEl = camTimeline.querySelector(".ct-frame");
  const ctFillEl  = camTimeline.querySelector(".ct-fill");
  const ctBarEl   = camTimeline.querySelector(".ct-bar");

  // -----------------------------------------------------------------
  // Scrub interaction — drag the progress bar to seek through the
  // authored fly-through (YouTube-style timeline scrubbing).
  //
  // The whole .cam-timeline carries pointer-events: none so users can
  // keep orbiting / panning the scene while the move plays, but the
  // bar itself opts back in (style.css: .ct-bar { pointer-events:
  // auto }). Pointer capture on .ct-bar means a drag that started on
  // the bar keeps routing to it even if the finger slides outside —
  // so the user can drag past the bar's edges without losing grip.
  //
  // Behaviour:
  //   • pointerdown — snap playhead to the tapped position, mark
  //     state PAUSED for the duration of the drag (we don't want the
  //     mixer auto-advancing while the user is in command)
  //   • pointermove — keep updating time as the finger moves
  //   • pointerup   — release pointer capture; if the user was PLAYING
  //     before grabbing the bar, resume playback from the new time;
  //     if they were PAUSED, stay paused at the new time
  //   • clamp seek to [0, dur - 0.01s] so we never trigger the
  //     mixer's "finished" event mid-drag (which would close the
  //     timeline panel and break the interaction)
  // -----------------------------------------------------------------
  let _scrubActive    = false;
  let _scrubPrevState = null;
  const _scrubFwd     = new THREE.Vector3();

  function _scrubTo(clientX) {
    if (!camAction || !camMixer || !camAnimNode) return;
    const rect = ctBarEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    const u = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const dur = camAction.getClip().duration;
    // Stay just short of dur so update(0) can't trip the "finished"
    // event during a scrub. Natural playback (release at end → mixer
    // auto-advances past dur next tick) still fires the cleanup.
    camAction.time = Math.min(u * dur, Math.max(0, dur - 0.01));
    camMixer.update(0);
    camAnimNode.updateWorldMatrix(true, false);
    camAnimNode.getWorldPosition(camera.position);
    camAnimNode.getWorldQuaternion(camera.quaternion);
    _scrubFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    controls.target.copy(camera.position).add(_scrubFwd);
    // Sync HUD inline so the timeline reads the new position even
    // when we're paused (next __camMoveTick wouldn't repaint it).
    const t   = camAction.time;
    const frT = Math.floor(t   * CAM_FPS);
    const frD = Math.floor(dur * CAM_FPS);
    ctTimeEl.textContent  = `${t.toFixed(2)}s / ${dur.toFixed(2)}s`;
    ctFrameEl.textContent = `F ${frT} / ${frD}`;
    ctFillEl.style.width  = `${(t / dur) * 100}%`;
  }

  ctBarEl.addEventListener("pointerdown", (e) => {
    if (!camAction) return;
    _scrubActive    = true;
    _scrubPrevState = camMoveState;
    // Pause auto-advance while the user owns the playhead. We don't
    // set state to "idle" because that hides the timeline + makes
    // __camMoveTick bail early; "paused" keeps the camAnimNode sync
    // path alive without progressing time.
    if (camMoveState === "playing") camMoveState = "paused";
    camTimeline.classList.add("scrubbing");
    try { ctBarEl.setPointerCapture(e.pointerId); } catch {}
    _scrubTo(e.clientX);
    e.preventDefault();
  });
  ctBarEl.addEventListener("pointermove", (e) => {
    if (_scrubActive) _scrubTo(e.clientX);
  });
  const endScrub = (e) => {
    if (!_scrubActive) return;
    _scrubActive = false;
    try { ctBarEl.releasePointerCapture(e.pointerId); } catch {}
    camTimeline.classList.remove("scrubbing");
    // Restore prior playback intent: if the user was actively playing
    // when they grabbed the bar, resume from the new seek position.
    // If they were already paused (or scrubbed from a paused state),
    // stay paused — they're inspecting a specific frame.
    if (_scrubPrevState === "playing") camMoveState = "playing";
    // Snap-style micro-feedback at the seek commit. Low-energy tic so
    // it reads as "released here" rather than "new event".
    haptic(8);
    playSound("tic");
  };
  ctBarEl.addEventListener("pointerup",     endScrub);
  ctBarEl.addEventListener("pointercancel", endScrub);

  // 4 equally-spaced phases across the clip duration:
  //   ¼ — Gaussian → Point         (begins immediately)
  //   ½ — Quad layer fades in      (overlay)
  //   ¾ — Quad layer fades out
  //   1 — Point → Gaussian         (back to 3DGS as the clip ends)
  // Snapshot of every collapsible panel's state taken when the intro
  // starts. Restored at intro end so the user's pre-intro UI layout
  // comes back exactly as they left it (user might have left the
  // sidebar collapsed deliberately — we don't want to "helpfully"
  // expand it for them). Also tracks gui._closed so the lil-gui
  // returns to its previous open/closed state.
  let _introPanelSnapshot = null;

  function camMoveStartLerps() {
    camTimeline.style.display = "flex";
    // Auto-collapse all floating UI so the intro reads as a clean
    // cinematic. Snapshot first so the restore at intro end matches
    // the user's pre-intro state. Skipped on phone (panels are CSS-
    // hidden there anyway; the mobile UI has its own bottom-bar +
    // sheets that don't fight the cinematic).
    if (!IS_PHONE) {
      _introPanelSnapshot = {
        sidebar:  _sidebarCollapseCtrl?.isCollapsed() ?? null,
        scene:    _sceneCollapseCtrl ?.isCollapsed() ?? null,
        hand:     _handCollapseCtrl  ?.isCollapsed() ?? null,
        guiClosed: gui._closed,
      };
      _sidebarCollapseCtrl?.setCollapsed(true, false);
      _sceneCollapseCtrl ?.setCollapsed(true, false);
      _handCollapseCtrl  ?.setCollapsed(true, false);
      gui.close();
    }
    // If a previous outro fade is still in flight (rapid re-Play), finalize
    // it before re-stashing — snap to the neutral lens state so the new
    // intro starts from a clean baseline.
    if (_introLensFadeStart > 0) {
      // Effect off + params snap to LENS_DEFAULTS so a later re-enable
      // shows the cinematic preset instead of the zeroed-out fade end.
      postfx.params.lensFisheye    = LENS_DEFAULTS.lensFisheye;
      postfx.params.lensAmt        = LENS_DEFAULTS.lensAmt;
      postfx.params.lensZoom       = LENS_DEFAULTS.lensZoom;
      postfx.params.lensDispersion = LENS_DEFAULTS.lensDispersion;
      postfx.params.lensSqueeze    = LENS_DEFAULTS.lensSqueeze;
      postfx.params.lensOn         = false;
      postfx.params.postEnable     = camMovePrevPostEnable;
      _introLensFadeStart = 0;
      _introTouchedLens   = false;
    }
    // Lens-stab: stash user's pre-play state. Stab itself fires per-
    // frame in __camMoveTick only when window.__autoPlayedIntro is set,
    // so manual Play Camera Move presses don't get the sting.
    camMovePrevLensOn      = postfx.params.lensOn;
    camMovePrevLensFisheye = postfx.params.lensFisheye;
    camMovePrevLensSqueeze = postfx.params.lensSqueeze;
    camMovePrevLensAmt     = postfx.params.lensAmt;
    camMovePrevPostEnable  = postfx.params.postEnable;
    _introLensActive       = false;
    _introTouchedLens      = false;
    // Force the lens pass on so the per-frame pulse in __camMoveTick
    // actually renders (the lens pass is gated by lensOn). postEnable
    // also forced so the composer runs even on phones.
    postfx.params.lensOn     = true;
    postfx.params.postEnable = true;
    camMovePrevCamFrustumsVisible = cameraFrustums?.visible ?? false;
    camMovePrevCamFrustumsOpacity = cameraFrustums?.material?.opacity ?? 0.85;
    _introFrustumsOn      = false;
    _introTouchedFrustums = false;

    if (!effects) return;
    camMovePrevSubform   = effects.targetSubform ?? 0;
    camMovePrevQuadVis   = effects.targetVis?.quad  ?? 0;
    camMovePrevQuadShape = effectParams.quadShape;
    // Voxel is no longer part of the cinematic — Voxelizer.setShape(
    // "sphere") would queue a slow rebuild (2-3 s on the 3 M splats)
    // that lands mid-playback. Showcasing the Circle subform in
    // Quadizer is a flat shader-uniform swap instead, so the second
    // half of the clip flips Billboard from Quad → Circle in place.
    effectParams.quadShape = "quad";
    if (quadizer) quadizer.setShape("quad");
    usdLayers?.refresh();      // sync the UsdLayers pill highlight

    const dur  = camAction?.getClip ? camAction.getClip().duration : 25;
    const beat = (dur / 4) * 1000;   // ms per equal phase

    camPhaseTimers.forEach(t => clearTimeout(t));
    camPhaseTimers = [];

    // Phased schedule across the clip. The Point→Gaussian transition
    // and the Billboard fade-out are now STAGGERED so the Circle
    // billboard reads as a long closer that overlaps the re-emerging
    // Gaussian splat for ~20 % of the clip:
    //   0      Gaussian → Point + lens pulse arms (lens ends by t=0.50)
    //   ¼      Billboard (square) fades in
    //   ½      Billboard subform swaps Quad → Circle (in place)
    //   0.625  Point → Gaussian — splat starts coming back while the
    //          Circle billboard is still fully visible (overlap window)
    //   0.825  Billboard fades out — exp-decay over ≈ 2.9 s leaves
    //          residual ~5 % at the absolute last frame
    effects.targetSubform = 1.0;

    // Phase 2 — Billboard (square shape) fades in
    camPhaseTimers.push(setTimeout(() => {
      if (camMoveState !== "playing") return;
      effects.setLayerVis("quad", true);
    }, beat));

    // Phase 3 — Billboard shape changes to Circle while still visible.
    // No layer fade — Quadizer flips the uIsCircle uniform and the
    // squares become discs on the very next frame.
    camPhaseTimers.push(setTimeout(() => {
      if (camMoveState !== "playing") return;
      effectParams.quadShape = "circle";
      if (quadizer) quadizer.setShape("circle");
      usdLayers?.refresh();
    }, beat * 2));

    // Phase 4 — Splat starts transitioning Point → Gaussian. Circle
    // billboard stays visible, so the overlap window of "Gaussian splat
    // + disc billboard" runs from here until the fade-out in Phase 5.
    camPhaseTimers.push(setTimeout(() => {
      if (camMoveState !== "playing") return;
      effects.targetSubform = 0.0;
    }, beat * 2.5));

    // Phase 5 — Billboard fades out. 0.7-beat tail (≈ 2.9 s) at
    // visTransitionRate 1.2/s lands the residual near 5 %.
    camPhaseTimers.push(setTimeout(() => {
      if (camMoveState !== "playing") return;
      effects.setLayerVis("quad", false);
    }, beat * 3.3));
  }
  function camMoveRevertLerps() {
    camPhaseTimers.forEach(t => clearTimeout(t));
    camPhaseTimers = [];
    camTimeline.style.display = "none";
    // Restore the floating UI to its pre-intro state. Persist:false
    // here so the user's actual saved preference (the localStorage
    // value set the last time they explicitly toggled a panel)
    // isn't overwritten by this transient intro-driven collapse.
    if (_introPanelSnapshot) {
      _sidebarCollapseCtrl?.setCollapsed(!!_introPanelSnapshot.sidebar, false);
      _sceneCollapseCtrl ?.setCollapsed(!!_introPanelSnapshot.scene,   false);
      _handCollapseCtrl  ?.setCollapsed(!!_introPanelSnapshot.hand,    false);
      if (!_introPanelSnapshot.guiClosed) gui.open();
      _introPanelSnapshot = null;
    }
    // Hand off lens restore to a short outro fade. Pre-intro defaults
    // (lensAmt = -1, lensSqueeze = 0.97 …) themselves produce distortion,
    // so we don't restore to them — instead the fade lerps every
    // distortion param toward neutral identity, then disables the pass.
    if (_introTouchedLens) {
      _introLensFadeFrom = {
        lensFisheye:    postfx.params.lensFisheye,
        lensAmt:        postfx.params.lensAmt,
        lensZoom:       postfx.params.lensZoom,
        lensDispersion: postfx.params.lensDispersion,
        lensSqueeze:    postfx.params.lensSqueeze,
      };
      _introLensFadeStart = performance.now();
      _introLensActive    = false;
      // _introTouchedLens stays true; the fade tick clears it on completion.
    }
    // Restore Training Cameras visibility to its pre-intro state and
    // resync the lil-gui Tech Spec checkbox so the UI matches reality.
    // Check the touched flag (not the on flag) so we still restore when
    // the intro ended while the frustums had just been turned off.
    if (_introTouchedFrustums) {
      if (cameraFrustums) {
        cameraFrustums.visible = camMovePrevCamFrustumsVisible;
        if (cameraFrustums.material) {
          cameraFrustums.material.opacity = camMovePrevCamFrustumsOpacity;
        }
      }
      dataParams.enabled = camMovePrevCamFrustumsVisible;
      if (camCtrl) camCtrl.updateDisplay();
      _introFrustumsOn      = false;
      _introTouchedFrustums = false;
    }

    if (!effects) return;
    effects.targetSubform = camMovePrevSubform;
    if (effects.targetVis) effects.targetVis.quad = camMovePrevQuadVis;
    // Restore the user's chosen Quad shape (Quad vs Circle). Voxel is
    // no longer touched by the cinematic, so its shape/visibility need
    // no restore.
    if (camMovePrevQuadShape) {
      effectParams.quadShape = camMovePrevQuadShape;
      if (quadizer) quadizer.setShape(camMovePrevQuadShape);
    }
    usdLayers?.refresh();
  }

  // Live-tunable transform on the FBX root so the user can frame the gazebo.
  // Defaults: 90° around -Y (correction confirmed earlier), small Y lift,
  // scale 0.5 (the raw FBX path overshoots; scaling shortens it). All four
  // are wired to GUI sliders below.
  // FBX camera-move transform — kept at the user's previous setting (-90°
  // around Y). Do not change without explicit ask; the Center viewpoint
  // override below handles "face the gazebo" separately.
  const camMoveXf = { ox: 0, oy: 0, oz: 0, scale: 0.5 };
  function applyCamFbxXf() {
    if (!camFbxRoot) return;
    camFbxRoot.rotation.set(0, -Math.PI / 2, 0);
    camFbxRoot.position.set(camMoveXf.ox, camMoveXf.oy, camMoveXf.oz);
    camFbxRoot.scale.set(camMoveXf.scale, camMoveXf.scale, camMoveXf.scale);
  }

  // Promise-cached load so concurrent callers (preload + user-Play) share one
  // fetch instead of racing and leaving camMixer null.
  let camLoadPromise = null;
  function loadCameraMove() {
    if (camFbxRoot)     return Promise.resolve();
    if (camLoadPromise) return camLoadPromise;
    camMoveLoading = true;
    camLoadPromise = (async () => {
      try {
        const fbx = await new FBXLoader().loadAsync(`${BASE}Shot4B_GS-FX_Camera_V01.fbx`);
        fbx.visible = false;
        scene.add(fbx);
        camFbxRoot = fbx;
        applyCamFbxXf();

        // Prefer a Camera node; fall back to the first non-root child.
        camAnimNode = null;
        fbx.traverse(o => { if (!camAnimNode && o.isCamera) camAnimNode = o; });
        if (!camAnimNode) fbx.traverse(o => { if (!camAnimNode && o !== fbx) camAnimNode = o; });
        if (!fbx.animations?.length) throw new Error("FBX has no animation");

        // The authored FBX is 600 frames at 24 fps (~25 s). We only want the
        // middle 400 frames (≈ 16.67 s) for the intro cinematic — the head /
        // tail of the clip have the camera ramping in/out of a static frame
        // which doesn't read well as a title-sequence. subclip rebases the
        // mixer time to 0 at the new start frame, so all downstream math
        // (action.time, getClip().duration, intro overlay tNorm, phase
        // timeline beat) automatically adapts.
        const fullClip   = fbx.animations[0];
        const middleClip = THREE.AnimationUtils.subclip(
          fullClip, "Shot4B_middle", 100, 500, CAM_FPS,
        );

        camMixer = new THREE.AnimationMixer(fbx);
        camAction = camMixer.clipAction(middleClip);
        camAction.setLoop(THREE.LoopOnce);
        camAction.clampWhenFinished = true;
        camMixer.addEventListener("finished", () => {
          camMoveRevertLerps();
          camMoveState = "idle";
          controls.enabled = true;
          document.body.classList.remove("intro-playing");
          // No extra controls.update() — the render-loop's per-frame
          // call (line ~2116) already runs every frame and re-reads
          // camera.position / target each pass, so the spherical state
          // syncs naturally without an explicit second update here.
          playCtrl.name("▶ Play Camera Move");
          statusEl.textContent = "Camera move complete";
          // End-of-cinematic title-card flourish — 3.1 s sequence
          // (700 ms fade-in + 1700 ms hold + 700 ms fade-out) so the
          // camera move feels authored to an ending instead of just
          // stopping. play() returns a promise that resolves AFTER
          // Cinematic flourish ("PlaySplat Studio Showcase" end card)
          // was retired per user feedback — "intro 播完不用再出现splat
          // garden 的文字介绍了 有点累赘". The opening title sequence
          // (introOverlay) and the loading splash already wordmark the
          // project at the start of the journey; a second wordmark at
          // the end of a single auto-played camera move reads as
          // redundant rather than as a bookend. We keep the resolved
          // Promise so the existing chained-onboarding code below
          // continues to fire on time, but skip the visible card.
          const flourishDone = Promise.resolve();
          // Tear down the intro overlay (fires immediately — the
          // overlay's own fade-out is fast).
          introOverlay?.hide();
          // Restore the Hand Tracking panel if the intro had hidden it
          // (don't unhide on phones, where it's permanently off via the
          // IS_PHONE startup block).
          const _handPanelAfterIntro = document.getElementById("hand-panel");
          if (_handPanelAfterIntro?.dataset?.introHidden === "1") {
            delete _handPanelAfterIntro.dataset.introHidden;
            if (!IS_PHONE) _handPanelAfterIntro.style.display = "";
          }
          if (window.__autoPlayedIntro) {
            window.__autoPlayedIntro = false;
            // First-visit onboarding — reduced to 2 BEATS (was 3).
            //   beat 1: Quick Guide (keyboard / mouse hints) — auto
            //   beat 2: Pointer arrows calling out 3DGS/USD + Tech panels
            //
            // Removed: the third "USD tooltip auto-pop" — it was a no-op
            // anyway since the USD spec badge moved into the always-
            // visible 3DGS/USD panel, and the dead timer just added
            // perceived load-time to the onboarding teaching sequence.
            //
            // Lengthened the gap between beats from ~340 ms → ~900 ms so
            // each teaching surface gets a moment to be read before the
            // next one slides in. Less barrage, same coverage.
            flourishDone.then(() => {
              setTimeout(() => keyHints?.showFor(6500), 120);
              // OnboardingPointers (animated arrows) removed — the
              // anchors drifted on smaller / narrower viewports so the
              // arrows kept pointing at empty space. Quick Guide alone
              // covers the same content reliably.
            });
          }
        });

        // Center viewpoint is patched by the COLMAP loader to capture
        // cam #582 (see loadColmapImages .then above). FBX patching
        // removed — the cinematic flythrough no longer owns Center.
      } catch (err) {
        console.warn("[CameraMove] failed:", err?.message ?? err);
        statusEl.textContent = "Camera move failed: " + (err?.message ?? err);
      } finally {
        camMoveLoading = false;
      }
    })();
    return camLoadPromise;
  }

  async function playPauseCameraMove() {
    if (!camMixer) {
      statusEl.textContent = "Loading camera move…";
      await loadCameraMove();
      if (!camMixer) return;
    }
    if (camMoveState === "playing") {
      // → pause
      camAction.paused = true;
      camMoveState = "paused";
      playCtrl.name("▶ Resume Camera Move");
      statusEl.textContent = "Camera move paused";
      // Re-enable canvas / hotspot interaction while paused — the user
      // may want to scrub or peek without the cinematic being live.
      document.body.classList.remove("intro-playing");
    } else {
      // idle or paused → play
      if (camMoveState === "idle") {
        camAction.reset();
        camAction.play();
        if (annotations) annotations.tween = null;       // cancel any flyTo tween
        camMoveStartLerps();
      }
      camAction.paused = false;
      camMoveState = "playing";
      controls.enabled = false;
      playCtrl.name("⏸ Pause Camera Move");
      statusEl.textContent = "Playing camera move…";
      // Block accidental clicks on the canvas / hotspots / viewpoint dots
      // while the cinematic is running — the user shouldn't trigger Scan
      // FX or fly-tos in the middle of an authored shot. The body class
      // is the canonical signal; CSS handles the visual side (pointer-
      // events: none on the relevant surfaces) and the click handlers
      // also early-return when this class is present as a belt-and-braces.
      document.body.classList.add("intro-playing");
    }
  }

  function stopCameraMove() {
    if (!camMixer) return;
    camAction.stop();
    camMoveRevertLerps();
    camMoveState = "idle";
    controls.enabled = true;
    document.body.classList.remove("intro-playing");
    playCtrl.name("▶ Play Camera Move");
    statusEl.textContent = "Camera move stopped";
  }

  // Export Intro Video — arm the title overlay, start MediaRecorder, play
  // the cinematic, then stop + download once the lens-outro fade completes.
  // Holds the user's __autoPlayedIntro state so manual play sessions before
  // / after the export are not affected.
  async function exportIntroVideo() {
    if (!IntroRecorder.isSupported()) {
      statusEl.textContent = "Video export not supported in this browser";
      return;
    }
    if (introRecorder.recording) return;
    if (!camMixer) {
      statusEl.textContent = "Loading camera move…";
      await loadCameraMove();
      if (!camMixer) return;
    }
    if (camMoveState !== "idle") stopCameraMove();

    const restoreAuto = window.__autoPlayedIntro;
    window.__autoPlayedIntro = true;
    introOverlay.show();

    introRecorder.start();
    statusEl.textContent = "Recording intro…";
    exportCtrl.name("● Recording intro…");
    exportCtrl.disable?.();
    playCtrl.disable?.();
    stopCtrl.disable?.();

    const onFinish = () => {
      camMixer.removeEventListener("finished", onFinish);
      // Hold a tick past the lens-outro fade so the final frames record
      // the gentle settle-to-neutral, then write the file.
      setTimeout(async () => {
        const blob = await introRecorder.stop();
        if (blob) {
          introRecorder.download(blob);
          statusEl.textContent = "Intro video saved";
        } else {
          statusEl.textContent = "Recording failed";
        }
        window.__autoPlayedIntro = restoreAuto;
        exportCtrl.name("⬇ Export Intro Video");
        exportCtrl.enable?.();
        playCtrl.enable?.();
        stopCtrl.enable?.();
      }, INTRO_LENS_FADE_MS + 250);
    };
    camMixer.addEventListener("finished", onFinish);

    playPauseCameraMove();
  }

  const camMoveParams = {
    play:   () => playPauseCameraMove(),
    stop:   () => stopCameraMove(),
    export: () => exportIntroVideo(),
  };
  // Expose so the mobile bottom-bar's Camera sheet can drive playback
  // without having to reach into this closure.
  window.__camMovePlayPause = () => playPauseCameraMove();
  window.__camMoveStop      = () => stopCameraMove();
  const playCtrl = fOverlay.add(camMoveParams, "play").name("▶ Play Camera Move");
  playCtrl.domElement.title = "Play / pause the pre-authored camera move (Shot4B_GS-FX_Camera_V01.fbx).";
  const stopCtrl = fOverlay.add(camMoveParams, "stop").name("■ Stop Camera Move");
  stopCtrl.domElement.title = "Reset the camera move to the beginning and return control to the user.";
  const exportCtrl = fOverlay.add(camMoveParams, "export").name("⬇ Export Intro Video");
  exportCtrl.domElement.title = "Record the full intro cinematic (camera move + overlay) and save as .webm.";
  // Replay Intro — lives here (not in Tech Spec) because it's a
  // camera-move action conceptually: re-fire the intro cinematic,
  // including the title-sequence overlay + onboarding pointers.
  const replayCtrl = fOverlay.add({ replay: window.__replayIntro }, "replay").name("↻ Replay Intro");
  replayCtrl.domElement.title = "Reset the first-visit flag and reload so the opening cinematic plays again.";

  // Live tuning so you can frame the gazebo while the move plays.
  const fCamTune = fOverlay.addFolder("Camera Move Tuning").close();
  fCamTune.add(camMoveXf, "ox",    -30, 30, 0.1).name("Offset X").onChange(applyCamFbxXf);
  fCamTune.add(camMoveXf, "oy",    -10, 20, 0.1).name("Offset Y").onChange(applyCamFbxXf);
  fCamTune.add(camMoveXf, "oz",    -30, 30, 0.1).name("Offset Z").onChange(applyCamFbxXf);
  fCamTune.add(camMoveXf, "scale", 0.05, 3.0, 0.05).name("Scale").onChange(applyCamFbxXf);

  // ---- Orbit Tour — procedural bbox orbit, works on ANY scene -------------
  // The authored FBX flythrough only fits the bundled scene; this is the
  // open, parameterized tour for everything else (and a quick auto-orbit
  // for the bundled scene too). All sliders are read live by turntable.js,
  // so dragging one reshapes the orbit while it's playing. Distances are
  // multiples of the scene's bounding radius, so the defaults frame any
  // dropped-in splat.
  const fOrbit = fOverlay.addFolder("Orbit Tour");
  const _op = turntable.orbit;
  fOrbit.add({ play: () => {
    const layer = sceneLayers.getInteractive()?.mesh || splat;
    const b = layer?.userData?.bounds;
    if (!b) { window.__toast?.("No bounds available for this layer"); return; }
    window.__camMoveStop?.();
    const on = turntable.toggleOrbit(b.center, b.radius);
    window.__toast?.(on ? "Orbit tour — drag to take over" : "Orbit stopped");
  } }, "play").name("▶ Play / Stop Orbit");
  fOrbit.add(_op, "turnSeconds", 8, 120, 1).name("Seconds / Turn");
  fOrbit.add(_op, "radiusScale", 0.5, 4.0, 0.05).name("Distance ×R");
  fOrbit.add(_op, "heightScale", -1.0, 2.0, 0.05).name("Height ×R");
  fOrbit.add(_op, "lookHeight",  -1.0, 1.0, 0.02).name("Look Height ×R");
  fOrbit.add(_op, "direction", { Clockwise: 1, "Counter-CW": -1 }).name("Direction");

  // Per-frame sync: copy the animated FBX node's world transform to the scene
  // camera. When PAUSED the mixer's deltaTime is 0 so the camera holds still
  // but the scene continues to render normally.
  window.__camMoveTick = (dt) => {
    // Lens outro fade — runs after camMoveRevertLerps hands off and keeps
    // ticking even once camMoveState is "idle". Every distortion param
    // lerps from its end-of-intro value toward neutral identity; at fade
    // end the pass is disabled and params sit at fully neutral values, so
    // re-enabling the lens later starts from a clean no-distortion state.
    if (_introLensFadeStart > 0) {
      const tFade = (performance.now() - _introLensFadeStart) / INTRO_LENS_FADE_MS;
      if (tFade >= 1) {
        // Fade complete: turn the effect off + snap params to the
        // cinematic LENS_DEFAULTS so a later re-enable shows the
        // intended look (Fisheye 0.04 / Distortion -1 / Zoom 0.95 /
        // Dispersion 0.01 / Squeeze 0.97) instead of pure identity.
        postfx.params.lensFisheye    = LENS_DEFAULTS.lensFisheye;
        postfx.params.lensAmt        = LENS_DEFAULTS.lensAmt;
        postfx.params.lensZoom       = LENS_DEFAULTS.lensZoom;
        postfx.params.lensDispersion = LENS_DEFAULTS.lensDispersion;
        postfx.params.lensSqueeze    = LENS_DEFAULTS.lensSqueeze;
        postfx.params.lensOn         = false;
        postfx.params.postEnable     = camMovePrevPostEnable;
        _introLensFadeStart = 0;
        _introTouchedLens   = false;
      } else {
        // Ease-out cubic on the inverse: tFade=0 → at "from" values,
        // tFade=1 → at neutral. lerp(from, to, eased)
        const eased = 1 - Math.pow(1 - tFade, 3);
        const f = _introLensFadeFrom;
        postfx.params.lensFisheye    = f.lensFisheye    + (NEUTRAL_LENS.lensFisheye    - f.lensFisheye)    * eased;
        postfx.params.lensAmt        = f.lensAmt        + (NEUTRAL_LENS.lensAmt        - f.lensAmt)        * eased;
        postfx.params.lensZoom       = f.lensZoom       + (NEUTRAL_LENS.lensZoom       - f.lensZoom)       * eased;
        postfx.params.lensDispersion = f.lensDispersion + (NEUTRAL_LENS.lensDispersion - f.lensDispersion) * eased;
        postfx.params.lensSqueeze    = f.lensSqueeze    + (NEUTRAL_LENS.lensSqueeze    - f.lensSqueeze)    * eased;
      }
    }

    if (!camMixer || !camAnimNode) return;
    if (camMoveState === "idle") return;

    camMixer.update(camMoveState === "paused" ? 0 : dt);
    camAnimNode.updateWorldMatrix(true, false);
    camAnimNode.getWorldPosition(camera.position);
    camAnimNode.getWorldQuaternion(camera.quaternion);
    _camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    controls.target.copy(camera.position).add(_camFwd);

    const dur = camAction.getClip().duration;
    const t = Math.min(camAction.time, dur);
    const frT = Math.floor(t   * CAM_FPS);
    const frD = Math.floor(dur * CAM_FPS);
    ctTimeEl.textContent  = `${t.toFixed(2)}s / ${dur.toFixed(2)}s`;
    ctFrameEl.textContent = `F ${frT} / ${frD}`;
    ctFillEl.style.width  = `${(t / dur) * 100}%`;
    // Drive the intro-title overlay only when the first-visit auto-play
    // armed it; manual user-triggered playback skips the title sequence
    // so it doesn't get in the way.
    const tNorm = dur > 0 ? t / dur : 0;
    introRecorder.setIntroState(
      tNorm,
      !!(window.__autoPlayedIntro && camMoveState === "playing"),
    );
    if (window.__autoPlayedIntro && introOverlay) {
      introOverlay.update(tNorm, camMoveState === "playing");
      // Training Cameras fade — coincide with the POSE phase but with
      // soft edges so the iconography appears as the CAPTURE line is
      // already fading out, sits full-strength through the "990 camera
      // poses solved with COLMAP" caption, then drifts back to zero
      // well past the end of POSE. Edge detect drives the lil-gui
      // checkbox + Tech Spec restore flag.
      //   0.22 → 0.27   fade IN  (≈ 5 % / 800 ms)
      //   0.27 → 0.50   FULL opacity
      //   0.50 → 0.65   fade OUT (≈ 15 % / 2.5 s)
      const FADE_IN_AT   = 0.22;
      const FADE_IN_END  = 0.27;
      const FADE_OUT_AT  = 0.50;
      const FADE_OUT_END = 0.65;
      const FULL_OPACITY = camMovePrevCamFrustumsOpacity || 0.85;
      let targetOpacity = 0;
      if (tNorm >= FADE_IN_AT && tNorm < FADE_IN_END) {
        const u = (tNorm - FADE_IN_AT) / (FADE_IN_END - FADE_IN_AT);
        targetOpacity = (u * u * (3 - 2 * u)) * FULL_OPACITY;
      } else if (tNorm >= FADE_IN_END && tNorm < FADE_OUT_AT) {
        targetOpacity = FULL_OPACITY;
      } else if (tNorm >= FADE_OUT_AT && tNorm < FADE_OUT_END) {
        const u = (tNorm - FADE_OUT_AT) / (FADE_OUT_END - FADE_OUT_AT);
        targetOpacity = (1 - u * u * (3 - 2 * u)) * FULL_OPACITY;
      }
      const inCameraWindow = targetOpacity > 0.001 && camMoveState === "playing";
      if (cameraFrustums && cameraFrustums.material) {
        cameraFrustums.material.opacity = targetOpacity;
        cameraFrustums.visible = inCameraWindow;
      }
      if (inCameraWindow !== _introFrustumsOn) {
        _introFrustumsOn      = inCameraWindow;
        _introTouchedFrustums = true;
        dataParams.enabled = inCameraWindow;
        if (camCtrl) camCtrl.updateDisplay();
      }
    }
    // Lens pulse — locked in after iteration:
    //   lensFisheye = 0.26 * sin(π * t / duration)
    // Full-bell sin curve across the clip, peak 0.26 at midpoint.
    // Fires on every play; lensOn + postEnable force-on in
    // camMoveStartLerps, restored in camMoveRevertLerps.
    if (camMoveState === "playing" && dur > 0) {
      _introTouchedLens = true;
      const LENS_PULSE_PEAK = 0.26;
      const tNormLens = Math.max(0, Math.min(1, t / dur));
      postfx.params.lensFisheye = LENS_PULSE_PEAK * Math.sin(tNormLens * Math.PI);
    }
  };


  // ---- Raycaster ----
  const raycaster = new THREE.Raycaster();
  // For splats, the threshold scales with model size
  raycaster.params.Points = { threshold: Math.max(0.02, radius * 0.005) };
  annotations.setRaycaster(raycaster, splat);

  // ---- Brush mode + click handler ----
  // Brush off (default) → click-to-trigger (one-shot FX at click point).
  // Brush on             → press + drag = continuous paint via effects.brushAt.
  // Same flow drives mouse pointer events AND hand-pinch (see hand block below).
  const brushParams = { brush: false, effector: false };
  // Interaction folder (top-level under Customize, not nested under FX) —
  // these toggles control INPUT MODE (camera vs paint), which is a global
  // behaviour, not a click-effect setting. Living next to FX keeps it
  // discoverable but separates the concerns.
  const fInteraction = (gui.fCustomize || gui).addFolder("Interaction");
  fInteraction.add(brushParams, "brush").name("Brush Mode")
    .onChange(v => {
      canvas.style.cursor = v ? "crosshair" : "";
      // Lock OrbitControls while brushing so drag doesn't accidentally
      // tumble the camera — the user wants the brush stroke to register
      // as paint, not as a viewport rotation. Re-enables on toggle off.
      controls.enabled = !v;
    });
  const brushParent = fInteraction;   // legacy local — Effector Mode below appends here
  // Effector Mode (TD-style sphere effector for Dissolve). When on, brush
  // press+drag drives a spatial mask that dissolves splats inside the sphere;
  // splats outside snap back to home. Auto-switches effect to "Dissolve &
  // Reform" since the spatial override only lives in that shader path.
  brushParent.add(brushParams, "effector").name("Effector Mode")
    .onChange(v => {
      if (v) {
        params.effect = "Dissolve & Reform";
        // Refresh the Effect dropdown so the GUI shows the auto-switch.
        gui.controllersRecursive().forEach(c => {
          if (c.property === "effect") c.updateDisplay();
        });
        canvas.style.cursor = "crosshair";
      } else {
        effects.setMaskCenter(null);
        if (effectorMesh) effectorMesh.visible = false;
        if (!brushParams.brush) canvas.style.cursor = "";
      }
    });

  // ---- GPGPU Particles (Phase 2) --------------------------------------------
  // Top-level "Particles" folder under Customize — the particle system is a
  // separate render layer from the click-FX (which modify the splat shader),
  // so it lives outside FX to avoid conceptual blur. All knobs use the
  // gpParticle* prefix per the dedicated-params-per-fx preference.
  const gpParticleParams = {
    // Default driven by the Performance profile: Max Quality turns
    // particles ON out of the box; Battery / Balanced leave them OFF.
    enable:        _perfProfile.particles,
    pointSize:     16.0,
    fieldStrength: 3.0,
    damping:       0.94,
    gravityY:      -0.4,
    alpha:         1.0,
    // Sakura palette — quiet pastel for the velocity-field baseline,
    // warmer rose for the high-density peaks. Reads as cherry blossom
    // under additive blending.
    colorCool:     "#ffd1dc",
    colorHot:      "#ff8fb1",
  };
  const fGpParticles = (gui.fCustomize || gui).addFolder("Particles").close();
  fGpParticles.add(gpParticleParams, "enable").name("Enable")
    .onChange(v => gpgpuParticles.setEnabled(v));
  gpgpuParticles.setEnabled(gpParticleParams.enable);
  fGpParticles.add(gpParticleParams, "pointSize", 1, 60, 0.5).name("Point Size")
    .onChange(v => gpgpuParticles.setPointSize(v));
  fGpParticles.add(gpParticleParams, "fieldStrength", 0, 12, 0.1).name("Field Strength")
    .onChange(v => gpgpuParticles.setFieldStrength(v));
  fGpParticles.add(gpParticleParams, "damping", 0.5, 0.999, 0.001).name("Damping")
    .onChange(v => gpgpuParticles.setDamping(v));
  fGpParticles.add(gpParticleParams, "gravityY", -3, 3, 0.05).name("Gravity Y")
    .onChange(v => gpgpuParticles.setGravity(v));
  fGpParticles.add(gpParticleParams, "alpha", 0.05, 2.0, 0.01).name("Alpha")
    .onChange(v => gpgpuParticles.setAlphaMul(v));
  fGpParticles.addColor(gpParticleParams, "colorCool").name("Color Cool")
    .onChange(v => gpgpuParticles.setColorCool(v));
  fGpParticles.addColor(gpParticleParams, "colorHot").name("Color Hot")
    .onChange(v => gpgpuParticles.setColorHot(v));

  // ---- Phase 3: Seed particles from USD voxel layer --------------------
  // Voxelizer caches cellPositions/cellCount/cellBoundsMin/Max after each
  // rebuild. Button reads those, expands the particle AABB to the voxel
  // bounds (so seeded particles aren't immediately OOB-respawned), and
  // blits voxel positions into the pos RT. Particle count stays fixed
  // (4096) — voxels cycle if there are more, repeat if fewer.
  const voxelSeedActions = {
    seedFromVoxels: () => {
      if (!voxelizer || !voxelizer.cellPositions || !voxelizer.cellCount) {
        statusEl.textContent = "Voxel layer has no data yet. Enable Voxel layer first";
        return;
      }
      // 10% margin around voxel AABB so drift doesn't respawn at boundary.
      const mn = voxelizer.cellBoundsMin.clone();
      const mx = voxelizer.cellBoundsMax.clone();
      const pad = mx.clone().sub(mn).multiplyScalar(0.10);
      mn.sub(pad); mx.add(pad);
      gpgpuParticles.setBounds(mn, mx);
      gpgpuParticles.seedFromPositions(voxelizer.cellPositions, voxelizer.cellCount);

      // Clear any accumulated velocity-field impulses so the freshly-seeded
      // particles read at the voxel positions instead of being immediately
      // blown away by leftover mass from earlier cursor / pinch interaction.
      velocityField.clear();

      // HIDE the voxel layer — the voxel cubes have been "transformed" into
      // particles; leaving the bright instanced cubes visible drowns out the
      // additive particle sprites. effects.params.voxelLayer drives the
      // animated voxelVis uniform → voxelizer.setOpacity() fades the cubes
      // out smoothly. (The voxel data itself stays cached on voxelizer so
      // re-toggling Voxel rebuilds without re-iterating splats.)
      const fxParams = effects?.params;
      if (fxParams && fxParams.voxelLayer) {
        fxParams.voxelLayer = false;
        gui.controllersRecursive().forEach(c => {
          if (c.property === "voxelLayer" && c.object === fxParams) c.updateDisplay();
        });
      }

      gpgpuParticles.setEnabled(true);
      gpParticleParams.enable = true;
      gui.controllersRecursive().forEach(c => {
        if (c.property === "enable" && c.object === gpParticleParams) c.updateDisplay();
      });
      statusEl.textContent = `Seeded ${gpgpuParticles.N} particles from ${voxelizer.cellCount} voxels. Voxel layer hidden.`;
    },
  };
  fGpParticles.add(voxelSeedActions, "seedFromVoxels").name("Seed from USD Voxels");

  function rayHitLocal(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width)  * 2 - 1,
      -((clientY - rect.top)  / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    // Raycast the SPLAT layers only. The derived voxel / billboard layers are
    // instanced meshes (userData.fxDerived) whose Mesh.raycast tests a single
    // origin prototype, never the scattered instances — a hit there is bogus.
    // They follow the splat's hit point via the shared FX uniform, so the
    // click just needs the splat-surface hit. Filtering them also fixes the
    // old origin-prototype false hit when a derived layer was co-visible.
    const visible = sceneLayers?.getVisibleMeshes?.() ?? [splat];
    let targets = visible.filter(m => !m.userData?.fxDerived);
    // If every visible layer is derived (the user hid the splat via the Scene
    // panel and is looking at voxels / billboards only), fall back to the
    // FX-bound splat: force it visible for the raycast test ONLY. No render
    // happens inside this event handler, so it stays hidden on screen, and
    // the derived layers animate from the resulting hit point.
    let forced = null, forcedVis = false;
    if (!targets.length) {
      const fxSplat = effects?.mesh || splat;
      if (fxSplat) { forced = fxSplat; forcedVis = fxSplat.visible; fxSplat.visible = true; targets = [fxSplat]; }
    }
    if (!targets.length) return null;
    const hits = raycaster.intersectObjects(targets, false);
    if (forced) forced.visible = forcedVis;
    if (!hits?.[0]) return null;
    const hitObj = hits[0].object || splat;
    return { hit: hits[0], local: hitObj.worldToLocal(hits[0].point.clone()), object: hitObj };
  }

  let downPos = null;
  let mouseBrushing = false;
  // Raycasting 2.6 M splats is O(N), so throttle to ~30 Hz and skip when
  // the cursor barely moved since the last hit. Effects.brushAt's own
  // smoothing keeps the visual continuous between samples.
  let _lastBrushRayMs = 0;
  let _lastBrushX = -1e9, _lastBrushY = -1e9;
  const BRUSH_RAY_MS = 33;            // ~30 Hz
  const BRUSH_SKIP_PX2 = 9;           // 3 px

  function brushAtScreen(clientX, clientY) {
    const now = performance.now();
    const dx = clientX - _lastBrushX, dy = clientY - _lastBrushY;
    if (now - _lastBrushRayMs < BRUSH_RAY_MS && dx*dx + dy*dy < BRUSH_SKIP_PX2) return;
    _lastBrushRayMs = now;
    _lastBrushX = clientX; _lastBrushY = clientY;
    const r = rayHitLocal(clientX, clientY);
    if (r) {
      effects.brushAt(r.local);
      if (brushParams.effector) effects.setMaskCenter(r.local);
    }
  }

  // Particle-trail gate: the additive GPGPU trail sprites are styled for
  // the soft splat look. When the splat layer is toggled off and the hard
  // billboard / voxel representations carry the view, the white streaks
  // read as a stray overlay (user feedback), so velocity-field injection
  // is suppressed in that state — clicks still drive the per-layer FX.
  const trailsAllowed = () => effectParams.splatLayer !== false;

  canvas.addEventListener("pointerdown", (e) => {
    downPos = { x: e.clientX, y: e.clientY };
    if (brushParams.brush) {
      _lastBrushRayMs = 0; _lastBrushX = -1e9; _lastBrushY = -1e9;
      brushAtScreen(e.clientX, e.clientY);
      mouseBrushing = true;
    }
    // Inject mass + velocity into the global velocity field at the cursor.
    // Velocity vector is zero on press (no cursor delta yet); subsequent
    // moves push velocity proportional to delta — handled in pointermove.
    if (velocityField && trailsAllowed()) {
      const rect = canvas.getBoundingClientRect();
      velocityField.inject(
        (e.clientX - rect.left) / rect.width,
        1.0 - (e.clientY - rect.top) / rect.height,
        0, 0, 1.2, 0.06,
      );
    }
  });

  // Pointer-MOVE injects velocity into the field proportional to cursor
  // delta (so dragging stirs the field, not just clicking). Throttled to
  // ~30 Hz to keep the inject pass cost negligible.
  let _vfMoveMs = 0, _vfPrevX = -1, _vfPrevY = -1;
  canvas.addEventListener("pointermove", (e) => {
    if (!velocityField || !trailsAllowed()) return;
    const now = performance.now();
    if (now - _vfMoveMs < 33) return;
    _vfMoveMs = now;
    const rect = canvas.getBoundingClientRect();
    const ux = (e.clientX - rect.left) / rect.width;
    const uy = 1.0 - (e.clientY - rect.top) / rect.height;
    if (_vfPrevX >= 0) {
      const vx = (ux - _vfPrevX) * 60.0;   // pixels-per-frame → field-velocity
      const vy = (uy - _vfPrevY) * 60.0;
      velocityField.inject(ux, uy, vx, vy, 0.25, 0.05);
    }
    _vfPrevX = ux; _vfPrevY = uy;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!mouseBrushing || !brushParams.brush) return;
    brushAtScreen(e.clientX, e.clientY);
  });
  canvas.addEventListener("pointerup", (e) => {
    if (mouseBrushing) {
      effects.releaseBrush();
      if (brushParams.effector) effects.setMaskCenter(null);
      mouseBrushing = false;
      downPos = null;
      return;
    }
    if (!downPos) return;
    const dx = e.clientX - downPos.x;
    const dy = e.clientY - downPos.y;
    downPos = null;
    if (dx * dx + dy * dy > 9) return; // drag, not click

    // Card-dismiss-first guard: when an asset hover card is pinned
    // open, an empty-canvas click should close the card rather than
    // ALSO detonating the click FX. Hotspot dots stopPropagation on
    // pointer events, so reaching this handler with a pinned card
    // means the user tapped outside both the card and any dot —
    // a "close, please" signal, not a "fire the effect" signal.
    // Subsequent clicks (with the card now closed) fall through to
    // the FX trigger path below as normal.
    if (assetHover.dismiss?.()) return;

    const r = rayHitLocal(e.clientX, e.clientY);
    if (!r) { statusEl.textContent = "No splat hit at click"; return; }

    // Defer to annotation system if user armed "+ Add"
    if (annotations.handleCanvasClick(r.hit.point)) return;

    // Otherwise → trigger scan effect at hit point (in object space)
    effects.triggerAt(r.local);
    autoEnableEchoForClick();
    statusEl.textContent = `Hit (${r.hit.point.x.toFixed(2)}, ${r.hit.point.y.toFixed(2)}, ${r.hit.point.z.toFixed(2)})`;
  });

  // ---- Auto Echo Trails for click FX  (simple on/off, no lerp) ------------
  // Click → echoOn = true. A single setTimeout flips it off once the FX
  // window (fxDur + fadeTail) closes. Persistence and Mix are NOT
  // modulated — the user's GUI values are used as-is the whole time, so
  // there's zero surprise. Consecutive clicks reset the timer.
  // User preference: interaction should NOT auto-engage echo trails by
  // default. Echo Trails remains available as a manual toggle in the
  // Post-Process folder; flip this to true to restore the click-driven
  // auto-engage behaviour.
  const AUTO_ECHO_ON_CLICK = false;
  let _echoAutoTimer = null;
  const _echoGuiCtls = [];
  function refreshEchoGui() {
    if (_echoGuiCtls.length === 0) {
      gui.controllersRecursive().forEach(c => {
        if (c._name === "Enable" && c.object === postfx.params) {
          _echoGuiCtls.push(c);
        }
      });
    }
    for (const c of _echoGuiCtls) c.updateDisplay();
  }
  function autoEnableEchoForClick() {
    if (!AUTO_ECHO_ON_CLICK) return;   // default: interaction leaves echo off
    if (!postfx?.params) return;
    // Skip the auto-engaged echo trails on touch devices — the trail
    // pass is fill-rate-heavy and reads poorly under the larger touch
    // tap area, and the user explicitly didn't want it firing on mobile
    // or iPad. Users can still enable Echo Trails manually via lil-gui.
    if (IS_TOUCH) return;
    postfx.params.echoOn = true;
    refreshEchoGui();
    if (_echoAutoTimer) clearTimeout(_echoAutoTimer);
    const fxDur    = effectUniforms?.duration?.value ?? 2.5;
    const fadeTail = effects?.fadeTailS ?? 0.9;
    // Extra grace period so the persistence buffer can decay to invisibility
    // BEFORE we disable echoPass. Without this, the pass turning off snaps
    // any remaining trail content to black — looks like the trail vanished
    // in the middle of a fade-out. Solve for the time it takes persistence
    // to decay the trail to ~5% visibility at 60 fps; clamp the result so a
    // wild persistence value doesn't keep echo running forever.
    const persist  = Math.max(postfx.params.echoPersist, 0.5);
    const fadeOutS = Math.max(1, Math.min(15,
                       Math.log(0.05) / Math.log(persist) / 60));
    const durMs    = (fxDur + fadeTail + fadeOutS) * 1000;
    _echoAutoTimer = setTimeout(() => {
      postfx.params.echoOn = false;
      refreshEchoGui();
      _echoAutoTimer = null;
    }, durMs);
  }
  // Expose for the hand-tracking block below to share the same logic
  window.__brushParams = brushParams;
  window.__effects = effects;
  window.__effectUniforms = effectUniforms;
  window.__effectorMesh = effectorMesh;
  window.__postfx = postfx;

  // ---- Keyboard ----
  window.addEventListener("keydown", (e) => {
    if (e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA") return;
    if (e.key >= "1" && e.key <= "9") {
      annotations.flyToIndex(parseInt(e.key, 10) - 1);
    } else if (e.key === "v" || e.key === "V") {
      annotations.armAddViewpoint();
    } else if (e.key === "c" || e.key === "C") {
      // Overwrite the "Center" viewpoint with the current camera pose.
      const cvp = annotations.viewpoints.find(v => v.name === "Center");
      if (cvp) {
        cvp.position.copy(camera.position);
        cvp.target.copy(controls.target);
        statusEl.textContent = "Center viewpoint updated";
      }
    } else if (e.key === "r" || e.key === "R") {
      camera.position.copy(center).add(new THREE.Vector3(0, radius * 0.4, radius * 1.8));
      controls.target.copy(center);
      controls.update();
      annotations.activeId = null;
      annotations._rebuildList();
    } else if (e.key === "?" || e.key === "/" || e.key === "h" || e.key === "H") {
      // Re-summon the Quick Guide overlay. "?" is the universal "help"
      // affordance on desktop apps; "/" is the same key without Shift;
      // H is the legacy binding (the GUI tooltip says "summon back with H").
      keyHints?.showFor(6500);
    }
  });

  // ---- WASD / QE flythrough (like SuperSplat editor) -------------------
  // W/S — forward / backward along the look direction
  // A/D — strafe along camera right
  // Q/E — drop / rise along world up
  // Shift — 3× speed boost
  // Modifies BOTH camera.position and controls.target so the look direction
  // is preserved (we're moving the whole "rig" not just the camera).
  const moveKeys = { w:false, a:false, s:false, d:false, q:false, e:false, shift:false };
  window.addEventListener("keydown", (e) => {
    if (e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA") return;
    const k = e.key.toLowerCase();
    if (k in moveKeys) { moveKeys[k] = true; }
    if (e.key === "Shift") moveKeys.shift = true;
  });
  window.addEventListener("keyup", (e) => {
    const k = e.key.toLowerCase();
    if (k in moveKeys) { moveKeys[k] = false; }
    if (e.key === "Shift") moveKeys.shift = false;
  });
  // Blur — clear stuck keys (e.g. user alt-tabs while holding W)
  window.addEventListener("blur", () => {
    Object.keys(moveKeys).forEach(k => moveKeys[k] = false);
  });

  const _moveForward = new THREE.Vector3();
  const _moveRight   = new THREE.Vector3();
  const _moveDelta   = new THREE.Vector3();
  const MOVE_SPEED = Math.max(radius * 0.4, 1.5); // scene-aware base speed (m/s)
  // Expose so the animation loop can call it
  window.__wasdStep = (dt) => {
    if (annotations?.tween) return;        // suspend while camera is tweening
    if (twoPinchActive || onePinchActive) return; // don't fight hand control
    const speed = (moveKeys.shift ? 3.0 : 1.0) * MOVE_SPEED * dt;
    _moveDelta.set(0, 0, 0);
    camera.getWorldDirection(_moveForward);
    _moveRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    if (moveKeys.w) _moveDelta.addScaledVector(_moveForward,  speed);
    if (moveKeys.s) _moveDelta.addScaledVector(_moveForward, -speed);
    if (moveKeys.a) _moveDelta.addScaledVector(_moveRight,   -speed);
    if (moveKeys.d) _moveDelta.addScaledVector(_moveRight,    speed);
    if (moveKeys.q) _moveDelta.y -= speed;
    if (moveKeys.e) _moveDelta.y += speed;
    if (_moveDelta.lengthSq() > 1e-9) {
      camera.position.add(_moveDelta);
      controls.target.add(_moveDelta);
    }
  };

  // ---- Hand tracking (optional) ----
  const handHintEl = (() => {
    let el = document.querySelector("#hand-panel .hand-status");
    if (!el) {
      el = document.createElement("div");
      el.className = "hand-status";
      el.style.cssText = "font-size:10px;color:var(--text-dim);min-height:14px;";
      document.getElementById("hand-panel").appendChild(el);
    }
    return el;
  })();
  const handErrorEl = document.getElementById("hand-error");

  // Reuse the raycaster set up above. ndc scratch vector to avoid alloc.
  const ndc = new THREE.Vector2();
  const _palmHit = new THREE.Vector3();
  // Raycasting 2.6M splats is O(N), so we throttle it to ~30Hz and skip when
  // the cursor barely moved since the last raycast. HandController emits
  // onPalmActive at full 60fps with smoothed coords; smoothing of the hit
  // point between raycasts is handled by EffectController.brushAt + update.
  let _lastRayMs = 0;
  let _lastRayX = -1e9, _lastRayY = -1e9;

  // Reusable helper: project screen XY → object-space hit point on the splat.
  // Returns the THREE.Vector3 _palmHit (mutated) or null when missing.
  // Mirrors the mouse-path rayHitLocal: targets ALL visible splat layers so
  // hand interactions follow the visible layer (not always primary).
  function screenToLocalHit(screenX, screenY) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((screenX - rect.left) / rect.width) * 2 - 1,
      -((screenY - rect.top)  / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const targets = sceneLayers?.getVisibleMeshes?.() ?? [splat];
    if (!targets.length) return null;
    const hits = raycaster.intersectObjects(targets, false);
    if (!hits?.[0]) return null;
    _palmHit.copy(hits[0].point);
    (hits[0].object || splat).worldToLocal(_palmHit);
    return _palmHit;
  }

  // ===== Hand-driven camera control =====
  //
  // STATE MACHINE  (matches Apple Vision Pro / iPad multi-touch metaphor):
  //
  //   IDLE        — no pinching hands. Cursor only.
  //   ONE_PINCH   — one hand pinching:
  //                   • drag       → manual orbit (spherical around target)
  //                   • brief tap  → click → dissolve
  //   TWO_PINCH   — both hands pinching (two-hand mode only):
  //                   • spread/contract → zoom (camera distance to target)
  //                   • parallel drag   → pan (translate both target + camera)
  //
  // OrbitControls is disabled while ONE_PINCH or TWO_PINCH is active so the
  // mouse path doesn't compete with the synthesised hand path.
  // ============================================================================
  const PINCH_DRAG_THRESHOLD_PX = 6;

  // Scratch math objects (reused, never re-allocated per frame)
  const _orbitOffset  = new THREE.Vector3();
  const _orbitSph     = new THREE.Spherical();
  const _camRight     = new THREE.Vector3();
  const _camUp        = new THREE.Vector3();
  const _panVec       = new THREE.Vector3();

  // ----- ONE_PINCH state -----
  let onePinchActive   = false;
  let onePinchMoved    = false;
  const onePinchStart  = { x: 0, y: 0 };
  const onePinchPrev   = { x: 0, y: 0 };

  // ----- TWO_PINCH state (snapshots taken when entering the state) -----
  let twoPinchActive   = false;
  let twoPinchDist0    = 0;
  const twoPinchMid0   = { x: 0, y: 0 };
  const twoCamPos0     = new THREE.Vector3();
  const twoTarget0     = new THREE.Vector3();

  function handOrbit(dx, dy) {
    _orbitOffset.copy(camera.position).sub(controls.target);
    _orbitSph.setFromVector3(_orbitOffset);
    const sens = 2 * Math.PI * 0.7 / window.innerHeight;
    _orbitSph.theta -= dx * sens;
    _orbitSph.phi   -= dy * sens;
    _orbitSph.phi    = Math.max(0.001, Math.min(Math.PI - 0.001, _orbitSph.phi));
    _orbitOffset.setFromSpherical(_orbitSph);
    camera.position.copy(controls.target).add(_orbitOffset);
    camera.lookAt(controls.target);
  }

  // ----- Gesture HUD ---------------------------------------------------
  // Small floating chip that tells the user WHICH camera action their
  // current hand gesture is producing (ORBIT / ZOOM · PAN / TAP /
  // PINCH). The label text is set by the gesture lifecycle hooks
  // below; CSS handles the fade in/out. Without this, users see the
  // scene moving but can't tell whether they're driving orbit, zoom,
  // pan, or just a click.
  const _gestureHudEl   = document.getElementById("hand-gesture-hud");
  const _gestureLabelEl = _gestureHudEl?.querySelector(".hgh-label");
  let   _gestureHudClearT = 0;
  function setGestureHud(text) {
    if (!_gestureHudEl || !_gestureLabelEl) return;
    if (_gestureHudClearT) { clearTimeout(_gestureHudClearT); _gestureHudClearT = 0; }
    _gestureLabelEl.textContent = text;
    _gestureHudEl.removeAttribute("hidden");
    // Force reflow before .show so the transition fires on rapid re-show.
    void _gestureHudEl.offsetHeight;
    _gestureHudEl.classList.add("show");
  }
  function hideGestureHud(holdMs = 0) {
    if (!_gestureHudEl) return;
    const fire = () => {
      _gestureHudEl.classList.remove("show");
      // Defer hidden attr so the CSS opacity transition has a frame
      // to run before display:none takes effect.
      setTimeout(() => {
        if (!_gestureHudEl.classList.contains("show")) {
          _gestureHudEl.setAttribute("hidden", "");
        }
      }, 240);
    };
    if (holdMs > 0) _gestureHudClearT = setTimeout(fire, holdMs);
    else fire();
  }

  function startTwoPinch(p1, p2) {
    twoPinchActive = true;
    const dx = p1.x - p2.x, dy = p1.y - p2.y;
    twoPinchDist0   = Math.hypot(dx, dy) || 1;
    twoPinchMid0.x  = (p1.x + p2.x) * 0.5;
    twoPinchMid0.y  = (p1.y + p2.y) * 0.5;
    twoCamPos0.copy(camera.position);
    twoTarget0.copy(controls.target);
    controls.enabled = false;
    setGestureHud("ZOOM · PAN");
  }

  function updateTwoPinch(p1, p2) {
    if (!twoPinchActive) return;
    const dx = p1.x - p2.x, dy = p1.y - p2.y;
    const d  = Math.hypot(dx, dy) || 1;
    const midX = (p1.x + p2.x) * 0.5;
    const midY = (p1.y + p2.y) * 0.5;

    // ----- Zoom: distance scales inversely with hand spread ratio -----
    const scale       = d / twoPinchDist0;
    const startOffset = _orbitOffset.copy(twoCamPos0).sub(twoTarget0);
    const startDist   = startOffset.length();
    const newDist     = startDist / Math.max(scale, 0.05);

    // ----- Pan: screen midpoint delta → world-space translation -----
    camera.getWorldDirection(_panVec);                  // forward
    _camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    _camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const fovRad           = camera.fov * Math.PI / 180;
    const worldPerPxAtTarg = 2 * startDist * Math.tan(fovRad / 2) / window.innerHeight;
    const screenDx         = midX - twoPinchMid0.x;
    const screenDy         = midY - twoPinchMid0.y;
    _panVec.copy(_camRight).multiplyScalar(-screenDx * worldPerPxAtTarg)
           .addScaledVector(_camUp,        +screenDy * worldPerPxAtTarg);

    // Apply zoom + pan to target and camera.
    controls.target.copy(twoTarget0).add(_panVec);
    const newOffset = startOffset.clone().setLength(newDist);
    camera.position.copy(controls.target).add(newOffset);
    camera.lookAt(controls.target);
  }

  function endTwoPinch() {
    twoPinchActive = false;
    controls.enabled = true;
    hideGestureHud();
  }

  function startOnePinch(p) {
    onePinchActive = true;
    onePinchMoved  = false;
    onePinchStart.x = onePinchPrev.x = p.x;
    onePinchStart.y = onePinchPrev.y = p.y;
    const ux = p.x / window.innerWidth;
    const uy = 1.0 - p.y / window.innerHeight;
    // Pinch start also seeds the velocity field with a fresh impulse — same
    // pattern as mouse press. Subsequent pinch-moves push velocity (handled
    // in updateOnePinch).
    if (velocityField && trailsAllowed()) velocityField.inject(ux, uy, 0, 0, 1.5, 0.07);
    // Initial label — flips to ORBIT once the user crosses the
    // drag-threshold (handled inline in updateOnePinch).
    setGestureHud("PINCH");
  }

  let handBrushing = false;
  let _handBrushMs = 0, _handBrushX = -1e9, _handBrushY = -1e9;
  function updateOnePinch(p) {
    if (!onePinchActive) return;
    // Pinch-drag stirs the velocity field — same pattern as mouse-move,
    // velocity proportional to per-frame delta. Throttled implicitly by
    // HandController's input rate; cheap enough to call every event.
    if (velocityField && trailsAllowed()) {
      const ux = p.x / window.innerWidth;
      const uy = 1.0 - p.y / window.innerHeight;
      const ox = onePinchPrev.x / window.innerWidth;
      const oy = 1.0 - onePinchPrev.y / window.innerHeight;
      const vx = (ux - ox) * 60.0;
      const vy = (uy - oy) * 60.0;
      if (vx * vx + vy * vy > 1e-6) {
        velocityField.inject(ux, uy, vx, vy, 0.30, 0.06);
      }
    }
    const brushOn = window.__brushParams?.brush;
    if (brushOn) {
      // Brush mode: pinch+move paints continuously at the palm hit point.
      // Throttle the splat raycast (O(N)) to ~30Hz + skip micro-moves.
      controls.enabled = false;
      handBrushing = true;
      const now = performance.now();
      const dx = p.x - _handBrushX, dy = p.y - _handBrushY;
      if (now - _handBrushMs >= 33 || dx*dx + dy*dy >= 9) {
        _handBrushMs = now; _handBrushX = p.x; _handBrushY = p.y;
        const local = screenToLocalHit(p.x, p.y);
        if (local) {
          effects.brushAt(local);
          if (window.__brushParams?.effector) effects.setMaskCenter(local);
        }
      }
      onePinchPrev.x = p.x; onePinchPrev.y = p.y;
      return;
    }
    if (!onePinchMoved) {
      const dx = p.x - onePinchStart.x, dy = p.y - onePinchStart.y;
      if (dx*dx + dy*dy > PINCH_DRAG_THRESHOLD_PX ** 2) {
        onePinchMoved = true;
        controls.enabled = false;
        // Drag threshold crossed → this is now an ORBIT, not a tap.
        setGestureHud(brushOn ? "PAINT" : "ORBIT");
      }
    }
    if (onePinchMoved) {
      handOrbit(p.x - onePinchPrev.x, p.y - onePinchPrev.y);
    }
    onePinchPrev.x = p.x; onePinchPrev.y = p.y;
  }

  function endOnePinch(p) {
    if (!onePinchActive) return;
    if (handBrushing) {
      effects.releaseBrush();
      if (window.__brushParams?.effector) effects.setMaskCenter(null);
      handBrushing = false;
      hideGestureHud();
    } else if (!onePinchMoved) {
      // Quick tap → click → dissolve (no brush)
      const local = screenToLocalHit(p.x, p.y);
      if (local) {
        effects.triggerAt(local);
      }
      // Tap was effective — flash "TAP" briefly so the user sees the
      // click registered, then fade out.
      setGestureHud("TAP");
      hideGestureHud(550);
    } else {
      hideGestureHud();
    }
    onePinchActive = false;
    onePinchMoved  = false;
    controls.enabled = true;
  }

  // Landmark + skeleton visualization layer over the webcam preview —
  // gives users live feedback that the tracker has locked on their hand,
  // pinches light up in accent colour, and a yellow dashed line plus
  // pixel distance appears between palms when BOTH hands are pinching
  // (the gesture that drives 2-hand zoom / pan). Mounted into the same
  // wrapper that holds <video>; sized + redraws via its own rAF loop.
  const handPreviewWrap = handVideo?.parentElement || null;
  const handOverlay = handPreviewWrap
    ? new HandLandmarksOverlay({ mountEl: handPreviewWrap, videoEl: handVideo })
    : null;

  const hand = new HandController({
    canvas,
    video: handVideo,
    cursorEl:  handCursor,
    cursorEl2: handCursor2,
    statusEl:  handHintEl,
    mode:      "single",
    onHandsUpdate: (hands) => {
      // Pipe the snapshot to the overlay FIRST so the visualization stays
      // in lockstep with the gesture interpretation below.
      handOverlay?.update(hands);

      const pinching = hands.filter(h => h.present && h.pinching);
      const lastP    = pinching[pinching.length - 1]?.cursor;

      if (pinching.length === 2) {
        if (onePinchActive) { endOnePinch(onePinchPrev); }
        if (!twoPinchActive) startTwoPinch(pinching[0].cursor, pinching[1].cursor);
        else                 updateTwoPinch(pinching[0].cursor, pinching[1].cursor);
      } else if (pinching.length === 1) {
        if (twoPinchActive) endTwoPinch();
        if (!onePinchActive) startOnePinch(pinching[0].cursor);
        else                 updateOnePinch(pinching[0].cursor);
      } else {
        if (twoPinchActive) endTwoPinch();
        if (onePinchActive) endOnePinch(lastP || onePinchPrev);
      }
    },
  });
  hand.onError = (info) => {
    handErrorEl.hidden = false;
    handErrorEl.querySelector(".title").textContent = info.message;
    handErrorEl.querySelector(".hint").textContent  = info.hint;
    handToggle.classList.remove("active", "loading");
    handToggle.classList.add("error");
    handToggle.querySelector(".state").textContent = "ERR";
  };

  // Persist the hand-tracking preference. Re-enable automatically on next
  // load if (a) the user had it ON last session and (b) the browser still
  // remembers the camera permission grant (getUserMedia returns instantly
  // without a permission prompt). Without (b) we'd silently trigger a
  // permission popup on every page load, which is worse than just asking
  // the user to click the toggle once.
  const HAND_PREF_KEY = "playsplat:hand-tracking-on";

  handToggle.addEventListener("click", async () => {
    // Clear stale error UI on retry
    handErrorEl.hidden = true;
    handToggle.classList.remove("error");
    handToggle.classList.add("loading");
    handToggle.querySelector(".state").textContent = "…";
    const on = await hand.toggle();
    handToggle.classList.remove("loading");
    if (!handToggle.classList.contains("error")) {
      handToggle.classList.toggle("active", on);
      handToggle.querySelector(".state").textContent = on ? "ON" : "OFF";
      // Persist for next session — only after a successful toggle (errors
      // don't update the pref so a stuck "ON" doesn't keep blocking the
      // user on every reload).
      try { localStorage.setItem(HAND_PREF_KEY, on ? "1" : "0"); } catch {}
      // When the user actually engages hand tracking, surface the
      // gesture cheatsheet as a transient toast — the keyboard /
      // mouse hints in the sidebar intentionally don't list these
      // (they were dead weight for anyone not using a webcam) so we
      // teach the gestures *at the moment of relevance*. Auto-fades.
      if (on) showHandTrackingTip();
    }
  });

  // Auto-restore — fired AFTER the cinematic intro has settled so we don't
  // start a webcam stream while the user is being introduced to the scene.
  // navigator.permissions.query is the safest probe: if the camera grant
  // already exists (state === "granted"), the subsequent getUserMedia call
  // inside hand.toggle() won't prompt, so the auto-resume feels seamless.
  // On Safari / older browsers the API is missing — we skip auto-resume
  // there to avoid an unprompted permission popup at first paint.
  (async function _maybeRestoreHandPref() {
    let want;
    try { want = localStorage.getItem(HAND_PREF_KEY) === "1"; } catch { return; }
    if (!want) return;
    try {
      const probe = await navigator.permissions?.query?.({ name: "camera" });
      if (probe?.state !== "granted") return;        // would prompt — bail
    } catch { return; }                              // API missing — bail
    // Wait until the cinematic intro is done before claiming the webcam.
    const fire = () => handToggle.click();
    if (window.__autoPlayedIntro) {
      // Set during intro startup, cleared at first user interaction.
      // Poll briefly (≤ 6 s) for the flag to drop, then fire.
      const t0 = performance.now();
      const tick = () => {
        if (!window.__autoPlayedIntro) return fire();
        if (performance.now() - t0 > 6000) return;   // give up silently
        setTimeout(tick, 250);
      };
      setTimeout(tick, 250);
    } else {
      fire();
    }
  })();

  // ---- Hand-tracking gesture cheatsheet (transient toast) ----
  // Surfaced only the first ~5 s after the user toggles tracking ON.
  // Teach the gestures at the moment of relevance instead of squatting
  // permanent UI real estate (the sidebar hint rail used to list these
  // alongside WASD / mouse hints, which was wasted bytes for the 99 %
  // of visitors who never enable hand tracking). Auto-dismisses; tap
  // anywhere to dismiss earlier.
  let _handTipEl = null;
  let _handTipTimer = null;
  function showHandTrackingTip() {
    if (!_handTipEl) {
      _handTipEl = document.createElement("div");
      _handTipEl.id = "hand-tracking-tip";
      _handTipEl.innerHTML = `
        <div class="ht-title">Hand tracking on</div>
        <div class="ht-rows">
          <div class="ht-row"><span class="ht-glyph">✧</span><span>Pinch &middot; click</span></div>
          <div class="ht-row"><span class="ht-glyph">✿</span><span>Drag with one hand &middot; orbit</span></div>
          <div class="ht-row"><span class="ht-glyph">❀</span><span>Two hands &middot; zoom &amp; pan</span></div>
        </div>
      `;
      document.body.appendChild(_handTipEl);
      _handTipEl.addEventListener("click", () => hideHandTrackingTip());
    }
    _handTipEl.classList.add("show");
    clearTimeout(_handTipTimer);
    _handTipTimer = setTimeout(hideHandTrackingTip, 6000);
  }
  function hideHandTrackingTip() {
    _handTipEl?.classList.remove("show");
    clearTimeout(_handTipTimer);
    _handTipTimer = null;
  }

  // 1-Hand / 2-Hand mode switch
  handModeEl?.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      const m = btn.dataset.mode; // "single" | "two"
      handModeEl.querySelectorAll("button").forEach(b =>
        b.classList.toggle("active", b === btn));
      hand.setMode(m);
    });
  });

  // ---- Drag-and-drop splat upload -----------------------------------------
  // Drop adds a NEW secondary layer alongside the primary splat (the original
  // load). Effects / voxel / quad / annotations stay bound to the primary.
  // Use replaceSplatMesh() programmatically if you want the swap-and-rebind
  // behavior instead — drag-drop no longer triggers it.
  const dropZone = document.getElementById("drop-zone");

  async function addSplatLayer(options) {
    setLoading("Loading splat layer…");
    try {
      const built = await createSplat(options);
      sceneLayers.add({ mesh: built.splat, name: options.fileName || "Layer" });
      // Re-evaluate which layer is interactive. _retargetInteractiveLayer
      // owns the modifier-attach side-effect, so we don't pre-attach here
      // — that way a secondary that lands "behind" a visible primary stays
      // a pure renderer (no shader divergence between layers with shared
      // hit-point uniforms in different object-spaces).
      window.__retargetInteractiveLayer?.();

      // Hide the primary so the new upload reads as the headline scene.
      // The user clicked "Use My Own" — they want to see their splat,
      // not the PlaySplat scene with their splat hidden behind it.
      // The primary stays in `sceneLayers` (just .visible = false), so
      // an eye-toggle in the Scene panel brings it back.
      if (typeof splat !== "undefined" && splat) {
        const primaryLayer = sceneLayers.layers?.find?.((l) => l.mesh === splat);
        if (primaryLayer) sceneLayers.setVisible(primaryLayer.id, false);
      }

      // Reframe the camera onto the new splat's bounding box. Postshot /
      // Inria exports each have their own coordinate space, so a fresh
      // upload typically lands well outside the PlaySplat viewing
      // volume — without this reframe the user toggles "Use My Own" and
      // sees nothing because the camera is still pointed at the original
      // scene. Mirrors the initial load's reframe logic in loadSplat().
      //
      // window.__uploadMaxRange (set by the "Max range (m)" input in
      // the 3DGS / USD panel) caps the auto-detected radius. Use case:
      // exports with stray outlier splats produce a bbox that's 10×
      // larger than the actual scene, which without the cap would push
      // the camera into the void. A user-set range of, say, 5 m forces
      // the reframe to behave as if the scene is at most 5 m across,
      // even if the raw bbox claims 50.
      const { center: c, radius: rRaw } = built;
      let r = rRaw;
      const maxRange = Number(window.__uploadMaxRange);
      let capped = false;
      if (Number.isFinite(maxRange) && maxRange > 0 && Number.isFinite(rRaw) && rRaw > maxRange) {
        r = maxRange;
        capped = true;
      }
      if (c && Number.isFinite(r)) {
        camera.position.copy(c).add(new THREE.Vector3(0, r * 0.4, r * 1.8));
        controls.target.copy(c);
        controls.update();
      }

      statusEl.textContent = `+ ${options.fileName || "splat"}`;
      const rangeNote = capped
        ? ` — framed at ${r.toFixed(1)} m (capped from ${rRaw.toFixed(1)} m)`
        : (Number.isFinite(rRaw) ? ` — framed at ${rRaw.toFixed(1)} m` : "");
      window.__toast?.(`Loaded ${options.fileName || "splat"}${rangeNote}`);

      // Bundled-scene-specific overlays (Training Cameras / Data Labels /
      // Daffodil + Grape Hyacinth hotspots) don't match a user-uploaded
      // splat — turn them off so the new asset is presented cleanly.
      // Re-enable via the Tech Spec Enable checkbox + reload if needed.
      if (typeof techEnableCtrl !== "undefined" && techEnableCtrl) {
        techEnableCtrl.setValue(false);
      }
      assetHover?.setVisible(false);
    } finally {
      hideLoading();
    }
  }

  // ---- Interactive-layer retargeting --------------------------------------
  // When the user toggles layer visibility in the Scene panel, we re-point
  // `effects.mesh` and reparent the wireframe effector so that whichever
  // layer is currently visible is the one that responds to clicks / brush /
  // hand. Raycast targets are queried fresh per-event from
  // sceneLayers.getVisibleMeshes(), so they don't need a separate hook.
  //
  // Voxelizer + Quadizer follow the interactive layer: their cells were
  // baked from one specific splat's positions, so a retarget re-binds the
  // source and disposes the stale build. The actual rebuild stays lazy —
  // the render loop already rebuilds on demand when the layer's vis fades
  // in and no mesh exists — so the (up to ~2 s) bake cost lands only when
  // the voxel/billboard layer is actually shown for the new source.
  let _activeInteractive = splat;
  window.__retargetInteractiveLayer = function _retargetInteractiveLayer() {
    const active = sceneLayers.getInteractive()?.mesh || splat;
    if (active === _activeInteractive) return;
    const prev = _activeInteractive;
    _activeInteractive = active;
    // Move the scan modifier off the previous active mesh and onto the new
    // one. We deliberately keep only ONE mesh with the modifier at a time
    // because `uniforms.hit` is shared module-level state in effects.js —
    // if two meshes both ran the modifier, they'd interpret the same hit
    // point in their own object-spaces and play the scan in different
    // world locations on each layer (visible discrepancy when both layers
    // are shown). Single-active keeps the effect anchored to the layer the
    // user actually clicked / brushed.
    if (prev) {
      prev.objectModifier = null;
      prev.updateGenerator?.();
    }
    if (active) {
      active.objectModifier = createScanModifier();
      active.updateGenerator?.();
    }
    if (effects) effects.mesh = active;
    window.__effects = effects;     // refresh dev pointer
    // Re-bake the derived representations for the new interactive splat.
    // Dispose now; the lazy build in the render loop (vis > 0 && !mesh)
    // re-clusters from the new source on the next fade-in.
    if (voxelizer && voxelizer.splatMesh !== active) {
      voxelizer.dispose();
      voxelizer.splatMesh = active;
      voxelizer._dirty = true;
    }
    if (quadizer && quadizer.splatMesh !== active) {
      quadizer.dispose();
      quadizer.splatMesh = active;
      quadizer._dirty = true;
    }
    // Reparent the wireframe effector sphere under the new active mesh so
    // its local transform matches uniforms.maskCenter (which is now in the
    // new active mesh's object-space).
    if (effectorMesh && effectorMesh.parent !== active) {
      effectorMesh.parent?.remove(effectorMesh);
      active.add(effectorMesh);
    }
    statusEl.textContent = `Interactive layer → ${active === splat ? "primary" : "secondary"}`;
  };

  // Tour routing — the Playbar's Tour button (and anything else that wants
  // "give me a camera tour of what I'm looking at") goes through here. The
  // bundled scene keeps its hand-authored cinematic; every other layer gets
  // the procedural bbox turntable, so Tour works for ANY dropped-in splat
  // (the train scene's origin differs wildly from the garden's — pointing
  // the authored clip at it would frame empty space).
  window.__tourToggle = function _tourToggle() {
    const active = sceneLayers.getInteractive()?.mesh || splat;
    // Authored FBX cinematic ONLY when the bundled authored scene is the
    // primary AND we're touring it. A generic primary (train, user drop)
    // has no matching clip — `active === splat` alone would wrongly fire
    // the garden flythrough on it, so gate on SCENE.authored too.
    if (SCENE.authored && active === splat) {
      turntable.stop();
      window.__camMovePlayPause?.();
      return;
    }
    window.__camMoveStop?.();
    const b = active?.userData?.bounds;
    if (!b) { window.__toast?.("No bounds available for this layer"); return; }
    const on = turntable.toggleOrbit(b.center, b.radius);
    window.__toast?.(on ? "Orbit tour — drag to take over" : "Tour stopped");
  };

  // Viewpoint-sequence tour — strings the saved Viewpoints into one smooth
  // Catmull-Rom flight. This is the user-authored counterpart to the
  // procedural orbit: stamp a few viewpoints, press play, the camera eases
  // through each and loops. Works for any scene (the poses are whatever the
  // user saved, in the scene's own frame).
  window.__playViewpointTour = function _playViewpointTour() {
    window.__camMoveStop?.();
    const vps = annotations?.viewpoints ?? [];
    if (vps.length < 2) {
      window.__toast?.("Add at least 2 viewpoints first (press V)");
      return false;
    }
    const poses = vps.map(v => ({ position: v.position, target: v.target }));
    const on = turntable.playSequence(poses);
    window.__toast?.(on ? `Touring ${vps.length} viewpoints — drag to take over` : "Tour stopped");
    return on;
  };

  // Hidden file input wired to Scene panel's "+ Add" button.
  const addSplatInput = document.createElement("input");
  addSplatInput.type   = "file";
  addSplatInput.accept = ".splat,.ply,.spz,.ksplat";
  addSplatInput.style.display = "none";
  document.body.appendChild(addSplatInput);
  addSplatInput.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";   // allow re-picking the same file
    if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      await addSplatLayer({ fileBytes: new Uint8Array(buf), fileName: f.name });
    } catch (err) {
      console.error("Add splat layer failed:", err);
      statusEl.textContent = "Load failed: " + (err?.message ?? err);
    }
  });
  sceneLayers.onAddRequest = () => addSplatInput.click();

  async function replaceSplatMesh(options) {
    setLoading("Loading splat…");
    if (splat) {
      scene.remove(splat);
      if (typeof splat.dispose === "function") splat.dispose();
    }
    voxelizer?.dispose?.();
    quadizer?.dispose?.();

    const built = await createSplat(options);
    splat = built.splat;
    scene.add(splat);
    splat.objectModifier = createScanModifier();
    splat.updateGenerator();

    // Re-point all downstream consumers at the new mesh
    if (effects)    effects.mesh    = splat;
    if (voxelizer)  voxelizer.splatMesh = splat;
    if (quadizer)   quadizer.splatMesh  = splat;
    _hudRefs.splat  = splat;     // keep Pipeline HUD pointed at live splat

    // Reframe + reset annotations / labels / raycast threshold
    const { center: c2, size: s2, radius: r2 } = built;
    camera.position.copy(c2).add(new THREE.Vector3(0, r2 * 0.4, r2 * 1.8));
    controls.target.copy(c2);
    controls.update();

    raycaster.params.Points = { threshold: Math.max(0.02, r2 * 0.005) };
    annotations.setRaycaster(raycaster, splat);
    annotations.viewpoints.slice().forEach(vp => annotations.removeViewpoint(vp.id));
    annotations.seedDefaults(c2, r2);
    dataLabels?.setBounds(c2, s2);

    hideLoading();
    statusEl.textContent = `${s2.x.toFixed(1)} × ${s2.y.toFixed(1)} × ${s2.z.toFixed(1)} m`;
  }

  // We have to count dragenter/dragleave to know when the user has truly left
  // the window — leaving a child element fires dragleave but the file is still
  // being dragged.
  let _dragDepth = 0;
  const SPLAT_EXT_RE = /\.(splat|ply|spz|ksplat)$/i;
  function showDrop(on) { dropZone.classList.toggle("active", on); }

  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    _dragDepth++;
    showDrop(true);
  });
  window.addEventListener("dragover",  (e) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  });
  window.addEventListener("dragleave", (e) => {
    _dragDepth = Math.max(0, _dragDepth - 1);
    if (_dragDepth === 0) showDrop(false);
  });
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    _dragDepth = 0;
    showDrop(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!SPLAT_EXT_RE.test(file.name)) {
      statusEl.textContent = `Unsupported file: ${file.name}`;
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      await addSplatLayer({ fileBytes: new Uint8Array(buf), fileName: file.name });
    } catch (err) {
      console.error("Add splat layer failed:", err);
      setLoading("Load failed: " + (err?.message ?? err));
      setTimeout(() => hideLoading(), 2500);
    }
  });

  hideLoading();

  // First-visit cinematic: auto-play the preauthored camera move once,
  // overlaid with the hero title + lower-third phase callouts. After the
  // clip finishes (or the user interacts), onboarding pointers fade in to
  // call out the discoverable panels. localStorage flag dedupes so repeat
  // visitors land directly in the interactive scene.
  const FIRST_VISIT_KEY = "playsplat:visited:v1";
  const isFirstVisit = (() => {
    try { return !localStorage.getItem(FIRST_VISIT_KEY); } catch { return false; }
  })();
  // A11y: visitors who've asked their OS for reduced motion shouldn't be
  // dragged through a 7-second swooping camera move that they didn't
  // request. We skip the cinematic outright AND mark the first-visit key
  // so a subsequent reload (with the preference cleared) doesn't auto-fire
  // either (the user landed in the scene already; the cinematic is a
  // one-shot "welcome" gesture, not a returning-user payload).
  const _prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  // Also skip the auto-play if a deep-link viewpoint landed us somewhere
  // specific — the user wanted THIS view, not the canned opening.
  // The cinematic is the garden's hand-authored FBX flythrough — it assumes
  // that scene's coordinates, so a generic scene (SCENE.authored === false)
  // skips it and lands directly in the interactive view with the Quick Guide.
  if (SCENE.authored && isFirstVisit && !_prefersReducedMotion && !window.__deepLinkLanded) {
    try { localStorage.setItem(FIRST_VISIT_KEY, String(Date.now())); } catch {}
    window.__autoPlayedIntro = true;
    introOverlay?.show();
    // Hide Hand Tracking during the cinematic — it competes for screen
    // real-estate with the title sequence and the layer-showcase. The
    // panel is restored by the mixer 'finished' handler (see above).
    const _handPanelDuringIntro = document.getElementById("hand-panel");
    if (_handPanelDuringIntro) _handPanelDuringIntro.dataset.introHidden = "1";
    if (_handPanelDuringIntro) _handPanelDuringIntro.style.display = "none";
    // Small beat after the splash hide so the camera move doesn't yank
    // the viewport at exactly the same instant the splash is leaving.
    setTimeout(() => { playPauseCameraMove(); }, 350);
  } else {
    // Repeat visitor — just show the Quick Guide on the usual timing.
    setTimeout(() => keyHints?.showFor(6500), 700);
  }

  // First-time hint so users know the default FX preset is click-armed —
  // otherwise they open the app, see the splat, don't realize clicking the
  // model fires the effect, and assume the FX panel is broken. Replaced by
  // hit coords on the first click; until then, this message stays.
  const initialPreset = effects?.params?.effect ?? "Slime Molds";
  statusEl.textContent =
    `${(size.x).toFixed(1)} × ${(size.y).toFixed(1)} × ${(size.z).toFixed(1)} m  ·  click the splat to fire "${initialPreset}"`;

  // Preload the FBX so Center=frame460 takes effect at startup. The promise
  // is fire-and-forget — concurrent calls from the Play button share it via
  // camLoadPromise.
  loadCameraMove();

  // Scan public/manifest.json for any other splat assets and load them as
  // hidden secondary layers. The Scene panel exposes them with eye toggles
  // so the user can swap which splat is rendering.
  loadAdditionalSplatLayers();

  // (Folder default fold state intentionally left as lil-gui's natural
  // open state — the showcase reads better with ALL controls visible at
  // first paint so users can SEE what's tweakable, vs. the previous
  // "Zone 1 only" approach which hid the depth of the studio behind
  // collapsed folders. Mobile still auto-collapses everything earlier
  // for the narrow-viewport sheet view.)
}

async function loadAdditionalSplatLayers() {
  let list = [];
  try {
    const res = await fetch(`${BASE}manifest.json`, { cache: "no-cache" });
    if (!res.ok) return;
    list = await res.json();
  } catch { return; }
  if (!Array.isArray(list)) return;

  // Compare by BASENAME only — manifest entries are bare filenames
  // ("PlaySplat_PC.splat") but SPLAT_URL is the full path
  // ("/PlaySplat/PlaySplat_PC.splat" on Pages). The old
  // `replace(/^\//, "")` left the BASE prefix intact, so the filter
  // never matched on production and the primary splat was loaded a
  // second time as a "secondary" — which is what produced the
  // duplicate `PlaySplat_PC · 3.00M` row in the Scene panel.
  const primaryFile = SPLAT_URL.split("/").pop();
  const secondaries = list.filter(f => typeof f === "string" && f && f !== primaryFile);

  for (const fname of secondaries) {
    try {
      const built = await createSplat({ url: `${BASE}${fname}` });
      const layer = sceneLayers.add({ mesh: built.splat, name: fname });
      if (layer) sceneLayers.setVisible(layer.id, false);   // hidden so it doesn't double-render
    } catch (err) {
      console.warn(`Skipping ${fname}:`, err?.message ?? err);
    }
  }
}

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let frameCount = 0;
let fpsLastMs = 0;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  profiler.beginFrame();
  profiler.begin("logic");

  // Annotation tween + screen-space marker update
  if (annotations) {
    annotations.updateTween(dt);
    annotations.updateMarkers(window.innerWidth, window.innerHeight);
  }

  // Data-label overlay (cards + bbox + ambient ticks)
  if (dataLabels) dataLabels.update(window.innerWidth, window.innerHeight);

  // Effector Mode wireframe sphere — tracks the hand-driven mask center.
  // maskCenter / maskRadius are written by effects.setMaskCenter() in the
  // brush handlers; visibility gated on uMaskActive so the sphere only
  // shows while the user is actively pressing / pinching.
  if (effectorMesh) {
    const on = effectUniforms.maskActive.value > 0.5;
    effectorMesh.visible = on;
    if (on) {
      effectorMesh.position.copy(effectUniforms.maskCenter.value);
      effectorMesh.scale.setScalar(effectUniforms.maskRadius.value);
    }
  }

  // Voxelizer / Quadizer opacity follows their layer-visibility uniform,
  // which is animated by EffectController when the corresponding checkbox
  // toggles. Build is lazy on first reveal (~2-3s JS pass over 2.6M splats).
  if (voxelizer) {
    const v = effectUniforms.voxelVis.value;
    if (v > 0.005 && !voxelizer.mesh && !voxelizer._busy) voxelizer.rebuild();
    voxelizer.setOpacity(v);
    voxelizer.syncFxUniforms(effectUniforms);
  }
  if (quadizer) {
    const q = effectUniforms.quadVis.value;
    if (q > 0.005 && !quadizer.mesh && !quadizer._busy) quadizer.rebuild();
    quadizer.setOpacity(q);
    quadizer.syncFxUniforms(effectUniforms);
  }

  // Effect uniforms
  if (effects) effects.update(dt);

  // Procedural orbit tour (no-op unless started via __tourToggle)
  turntable.update(dt);

  // Mirror Playbar button states to live params each frame (cheap dirty
  // check; repaints only on change) so Studio-panel edits reflect instantly.
  window.__playbar?.syncIfDirty?.();
  // Same for the 3DGS/USD eye panel — its toggles previously only repainted
  // on its own clicks, so Playbar-driven layer changes left its eye icons
  // stale. This closes the Playbar <-> USD-panel sync loop.
  window.__usdLayers?.syncIfDirty?.();

  // WASD / QE flythrough
  if (window.__wasdStep) window.__wasdStep(dt);

  // Pre-authored FBX camera move (drives camera while playing / paused)
  if (window.__camMoveTick) window.__camMoveTick(dt);

  controls.update();
  // Tick the Echo-Trails bell-curve ramp (no-op when idle).
  // (Echo auto-toggle handled by setTimeout in autoEnableEchoForClick — no per-frame tick needed.)
  // Convolve + advect the velocity field one step. Downstream readers
  // (Phase 2 particles, Phase 3 voxel particles) sample its texture.
  profiler.mark("step");
  velocityField.step();
  gpgpuParticles.step(dt, camera, velocityField.getTexture());
  // Sorted-particles sim removed — Warp FX is a pure-shader post-pass with
  // no companion sim, so the composer just renders directly.
  profiler.mark("compose");
  // Bypass the EffectComposer entirely when Post-Process is disabled —
  // otherwise the composer still runs RenderPass + every passthrough pass,
  // which lights up the compose phase for nothing.
  if (postfx.params?.postEnable === false) {
    renderer.render(scene, camera);
  } else {
    postfx.render(dt);
  }
  // GPGPU particles + Tech-Spec gizmos live in their own scenes rendered
  // AFTER the composer so they bypass every post-FX pass (Echo, Bloom,
  // Painterly, Underwater, etc.). autoClear=false preserves the composed
  // pixels underneath; both scenes are additive/overlay-style.
  profiler.mark("overlay");
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  if (gpgpuParticles.points.visible) {
    renderer.render(particleScene, camera);
  }
  if (techOverlayScene.children.length > 0) {
    renderer.render(techOverlayScene, camera);
  }
  renderer.autoClear = prevAutoClear;

  profiler.mark("hud");
  // Pipeline HUD removed — no per-frame tick needed.
  // Asset hover hotspots — project worldPos to screen each frame.
  assetHover?.update();
  // Viewport Tuner — refresh live pose readout (cheap, bails when closed).
  viewpointTuner?.update();

  // FPS readout — uses raw performance.now() (NOT the clamped dt, which
  // pegs at 20 fps because dt is capped at 50 ms). One decimal place so
  // sub-60 variation is visible. Suffix is regex-replaced so any base
  // text (size, hit coords, the initial hint, etc.) keeps its fps tail.
  frameCount++;
  const _fpsNow = performance.now();
  if (!fpsLastMs) fpsLastMs = _fpsNow;
  if (_fpsNow - fpsLastMs >= 500) {
    const fps = (frameCount * 1000 / (_fpsNow - fpsLastMs)).toFixed(1);
    if (statusEl) {
      const base = statusEl.textContent.replace(/\s*•\s*[\d.]+\s*fps$/, '');
      statusEl.textContent = `${base} • ${fps} fps`;
    }
    // Feed the mobile Info sheet's FPS readout (cheap; the sheet only
    // reads it the next time it opens — no DOM thrash here).
    window.__mobileUI?.tickFps?.(dt);
    frameCount = 0;
    fpsLastMs = _fpsNow;
  }
  profiler.endFrame();
});

loadSplat().catch((err) => {
  console.error(err);
  // PM-13: replace the previous "stuck-on-spinner with a sad message"
  // failure mode with a proper recoverable card. Common causes the user
  // can act on: (a) bad network → "Try again" reloads; (b) 404 / stale
  // cache → likewise a reload fixes; (c) corrupted file on the host →
  // hint visible in the body so the dev sees it in the console too.
  const msg = err?.message ?? String(err);
  const html =
    `The 3D Gaussian Splatting scene didn't finish loading.<br><br>` +
    `<code style="opacity:0.7;font-size:11px">${msg.replace(/</g, "&lt;")}</code>`;
  _showFatalError("Couldn't load the scene", html, true);
});
