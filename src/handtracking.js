// MediaPipe is dynamically imported inside _ensureModel() so the main
// bundle does not pay for ~hundreds of KB of WASM glue + landmarker
// code until the user actually toggles hand tracking on. Combined with
// the IS_PHONE Battery default (hand tracking off on phones out of the
// box), this means mobile first-paint never downloads the MediaPipe
// chunk at all unless the visitor explicitly opts in.

// ---------------------------------------------------------------------------
// HandController
//
// MediaPipe HandLandmarker wrapper with smoothed 2-hand cursor tracking,
// hysteretic pinch detection, and an iframe-aware webcam preflight.
// The controller emits a single onHandsUpdate(hands[]) callback per frame.
//
// `mode` selects how many hands the consumer sees:
//   "single" → only hands[0] is ever present (existing UX preserved)
//   "two"    → both hands[0] and hands[1] can be present simultaneously
//
// Each entry in the hands array:
//   { idx, present, cursor: {x,y}, pinching }
// ---------------------------------------------------------------------------

const WASM_CDN  = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";

const PALM_CENTER       = 9;
const THUMB_TIP         = 4;
const INDEX_TIP         = 8;
const NO_HAND_GRACE_MS  = 250;

const PINCH_ON          = 0.055;
const PINCH_OFF         = 0.085;

// ---------------------------------------------------------------------------
// One-Euro filter (Casiez et al. 2012) — adaptive smoothing.
// ---------------------------------------------------------------------------
class OneEuro {
  constructor({ minCutoff = 1.4, beta = 0.06, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta      = beta;
    this.dCutoff   = dCutoff;
    this.x         = null;
    this.dx        = 0;
    this.lastT     = 0;
  }
  _alpha(cutoff, dt) {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }
  filter(value, tMs) {
    if (this.x === null) { this.x = value; this.lastT = tMs; return value; }
    const dt = Math.max((tMs - this.lastT) / 1000, 1e-6);
    const dx = (value - this.x) / dt;
    const aD = this._alpha(this.dCutoff, dt);
    this.dx  = this.dx + aD * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a  = this._alpha(cutoff, dt);
    this.x   = this.x + a * (value - this.x);
    this.lastT = tMs;
    return this.x;
  }
  reset() { this.x = null; this.dx = 0; }
}

function makeHandSlot(cursorEl) {
  return {
    present:    false,
    pinching:   false,
    _wasPinch:  false,
    cursor:     { x: 0, y: 0 },     // smoothed pixel coords
    target:     { x: 0, y: 0 },     // latest detection target
    lastSeenAt: 0,
    _euroX: new OneEuro(),
    _euroY: new OneEuro(),
    cursorEl: cursorEl || null,
  };
}

export class HandController {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.canvas
   * @param {HTMLVideoElement}  opts.video
   * @param {HTMLElement}       opts.cursorEl      - primary hand cursor
   * @param {HTMLElement}       opts.cursorEl2     - secondary hand cursor (two-hand mode)
   * @param {HTMLElement}       opts.statusEl
   * @param {(hands)=>void}     opts.onHandsUpdate - per-frame state of both hands
   * @param {string}            opts.mode          - "single" (default) | "two"
   */
  constructor({ canvas, video, cursorEl, cursorEl2, statusEl, onHandsUpdate, mode = "single" }) {
    this.canvas        = canvas;
    this.video         = video;
    this.statusEl      = statusEl;
    this.onHandsUpdate = onHandsUpdate || (() => {});
    this.mode          = mode;

    this.enabled       = false;
    this.landmarker    = null;
    this.stream        = null;
    this.lastVideoTs   = -1;
    this._prevT        = 0;
    this._lastHintAt   = null;
    this.lerpRate      = 18;

    this.hands = [
      makeHandSlot(cursorEl),
      makeHandSlot(cursorEl2),
    ];
    this.onError = null;
  }

  setStatus(text) { if (this.statusEl) this.statusEl.textContent = text; }

  setMode(mode) {
    if (mode !== "single" && mode !== "two") return;
    if (mode === this.mode) return;
    this.mode = mode;
    // Hide second cursor when switching to single mode
    if (mode === "single") {
      const h = this.hands[1];
      h.present = h.pinching = h._wasPinch = false;
      if (h.cursorEl) h.cursorEl.style.display = "none";
      h._euroX.reset(); h._euroY.reset();
    }
  }

  preflightCheck() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return { code: "no-api", message: "Webcam API not available",
               hint: "Your browser doesn't support getUserMedia. Try a recent Chrome / Edge / Firefox." };
    }
    if (!window.isSecureContext) {
      return { code: "insecure", message: "Insecure context",
               hint: `Open via https:// or http://localhost (current: ${location.origin}).` };
    }
    if (window.self !== window.top) {
      const fp = document.featurePolicy || document.permissionsPolicy;
      const allowed = fp?.allowsFeature ? fp.allowsFeature("camera") : null;
      if (allowed === false) {
        return { code: "iframe", message: "Embedded preview blocks camera",
                 hint: "Open the app in a regular browser tab: http://127.0.0.1:5173/" };
      }
    }
    return null;
  }

  async _ensureModel() {
    if (this.landmarker) return;
    this.setStatus("Loading hand model…");
    // Dynamic import — first call fetches the MediaPipe chunk
    // (~hundreds of KB) on demand. Vite/Rollup code-splits this into
    // its own JS file via the manualChunks config in vite.config.js,
    // so the main bundle never includes MediaPipe and visitors who
    // never enable hand tracking never download it.
    const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
    this.landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      numHands: 2,                    // always track up to 2; mode just filters
      runningMode: "VIDEO",
    });
  }

  async start() {
    if (this.enabled) return;

    const pre = this.preflightCheck();
    if (pre) { this._raiseError(pre); return; }

    try {
      this.setStatus("Requesting webcam…");
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();

      await this._ensureModel();

      this.enabled = true;
      this.video.classList.add("active");
      this.setStatus("Looking for hand…");
      requestAnimationFrame(this._loop);
    } catch (err) {
      console.error("Hand tracking failed to start:", err);
      this.stop();
      this._raiseError(this._classify(err));
    }
  }

  stop() {
    this.enabled = false;
    this.video.classList.remove("active");
    for (const h of this.hands) {
      h.present = h.pinching = h._wasPinch = false;
      h._euroX.reset(); h._euroY.reset();
      if (h.cursorEl) {
        h.cursorEl.classList.remove("active", "pinch");
        h.cursorEl.style.display = "none";
      }
    }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.video.srcObject = null;
    this.setStatus("");
  }

  async toggle() {
    if (this.enabled) this.stop(); else await this.start();
    return this.enabled;
  }

  _classify(err) {
    const name = err?.name || "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return { code: "denied", message: "Webcam permission denied",
               hint: "Click the camera icon in the browser address bar and choose 'Allow', then click the button again. " +
                     "(If running inside an embedded preview/iframe, open http://127.0.0.1:5173/ in a regular browser tab.)" };
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      return { code: "no-device", message: "No webcam found",
               hint: "Plug in a webcam or enable a built-in camera in your OS settings." };
    }
    if (name === "NotReadableError") {
      return { code: "in-use", message: "Webcam in use",
               hint: "Another app (Zoom, OBS, Teams…) is using the camera. Close it and retry." };
    }
    return { code: "unknown", message: name || "Error", hint: err?.message || String(err) };
  }
  _raiseError(info) { if (this.onError) this.onError(info); }

  _loop = (t) => {
    if (!this.enabled) return;
    const dt = this._prevT ? Math.min((t - this._prevT) / 1000, 0.1) : 0;
    this._prevT = t;

    // Inference (rate-limited by video frame rate ~30fps)
    if (this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTs) {
      this.lastVideoTs = this.video.currentTime;
      let result = null;
      try {
        const ts = Math.max(1, Math.floor(t || performance.now()));
        result = this.landmarker.detectForVideo(this.video, ts);
      } catch (e) {
        console.warn("HandLandmarker detect error (continuing):", e?.message ?? e);
      }
      this._ingestResult(result, t);
    }

    // 60fps cursor smoothing + per-hand callbacks
    if (this.hands.some(h => h.present)) {
      const rect = this.canvas.getBoundingClientRect();
      const k = 1 - Math.exp(-this.lerpRate * dt);
      for (const h of this.hands) {
        if (!h.present) continue;
        h.cursor.x += (h.target.x - h.cursor.x) * k;
        h.cursor.y += (h.target.y - h.cursor.y) * k;
        if (h.cursorEl) {
          h.cursorEl.style.display   = "flex";
          h.cursorEl.classList.add("active");
          h.cursorEl.style.transform = `translate(${h.cursor.x}px, ${h.cursor.y}px)`;
          h.cursorEl.classList.toggle("pinch", h.pinching);
        }
      }
    }
    this._emitHandsUpdate();

    requestAnimationFrame(this._loop);
  };

  // Assign MediaPipe-detected hands to our internal two slots, stable by handedness.
  _ingestResult(result, tMs) {
    const lmList   = result?.landmarks || [];
    const handsRes = result?.handedness || [];
    const rect     = this.canvas.getBoundingClientRect();

    // Decide which detected hand goes into slot 0 / 1 based on handedness:
    //   slot[0] = "Right" hand by MediaPipe (which is user's LEFT after mirror)
    //   slot[1] = "Left"  hand by MediaPipe
    // This keeps slot identity stable across frames even if order swaps.
    const slot = [null, null];
    for (let i = 0; i < lmList.length; i++) {
      const cat = handsRes[i]?.[0]?.categoryName || (i === 0 ? "Right" : "Left");
      const idx = cat === "Left" ? 1 : 0;
      if (!slot[idx]) slot[idx] = lmList[i];
      else slot[idx === 0 ? 1 : 0] = lmList[i];     // fallback if 2 of same handedness
    }

    // Apply mode mask: in single mode, ignore slot[1]
    const allowed = this.mode === "two" ? 2 : 1;

    for (let i = 0; i < 2; i++) {
      const h  = this.hands[i];
      const lm = i < allowed ? slot[i] : null;
      if (lm) {
        this._updateHand(h, lm, tMs, rect);
      } else {
        // Hand absent — apply grace period before clearing
        if (h.present && tMs - h.lastSeenAt < NO_HAND_GRACE_MS) continue;
        if (h.present) this._clearHand(h);
      }
    }
  }

  _updateHand(h, lm, tMs, rect) {
    h.lastSeenAt = tMs;
    // Stash the full 21-landmark array so the visualization layer
    // (hand-landmarks-overlay.js) can draw the skeleton dots + bones
    // over the webcam preview. lm entries are { x, y, z } in
    // normalized image space (0..1, top-left origin).
    h.landmarks = lm;
    const fx = h._euroX.filter(lm[PALM_CENTER].x, tMs);
    const fy = h._euroY.filter(lm[PALM_CENTER].y, tMs);
    h.target.x = (1 - fx) * rect.width  + rect.left;
    h.target.y =       fy * rect.height + rect.top;

    if (!h.present) {
      h.cursor.x = h.target.x;
      h.cursor.y = h.target.y;
      h.present  = true;
      if (this._lastHintAt !== "track") {
        this.setStatus(this.mode === "two"
          ? "Tracking — two-hand pinch to zoom / pan"
          : "Tracking — pinch to click, pinch + drag to orbit");
        this._lastHintAt = "track";
      }
    }

    // Hysteretic pinch detection
    const t = lm[THUMB_TIP], i = lm[INDEX_TIP];
    const pinchDist = Math.hypot(t.x - i.x, t.y - i.y);
    if (!h.pinching && pinchDist < PINCH_ON)      h.pinching = true;
    else if (h.pinching && pinchDist > PINCH_OFF) h.pinching = false;
  }

  _clearHand(h) {
    h.present = false;
    h.pinching = false;
    h._wasPinch = false;
    h.landmarks = null;        // drop stashed pose so overlay stops drawing
    h._euroX.reset();
    h._euroY.reset();
    if (h.cursorEl) {
      h.cursorEl.classList.remove("active");
      h.cursorEl.style.display = "none";
    }
  }

  _emitHandsUpdate() {
    // Build a stable shape every frame for the consumer. `landmarks`
    // is the raw MediaPipe 21-point array (or null when the hand is
    // out of frame) — consumed by hand-landmarks-overlay.js to draw
    // the skeleton over the webcam preview. Passed by REFERENCE for
    // zero per-frame allocation; downstream code must not mutate.
    const snapshot = this.hands.map((h, idx) => ({
      idx,
      present:   h.present,
      pinching:  h.pinching,
      cursor:    { x: h.cursor.x, y: h.cursor.y },
      landmarks: h.landmarks,
    }));
    this.onHandsUpdate(snapshot);
  }
}
