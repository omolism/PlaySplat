// ---------------------------------------------------------------------------
// hand-landmarks-overlay.js — draws the 21-point MediaPipe hand skeleton
// (dots + bones + palm fill) on top of the webcam preview inside
// #hand-panel #hand-preview-wrap. Gives users immediate feedback that
// the system is correctly tracking their hand AND that pinch / multi-hand
// gestures are being detected — addresses the user complaint that
// "users don't know they're zooming or moving" during hand tracking.
//
// Reference-aligned styling (per the inspiration screenshots — finger
// landmark dots + connecting wires) but tuned for our dark UI:
//   • base bones in soft white at ~70% opacity
//   • landmark dots in solid white with a faint outer glow
//   • PALM polygon shaded translucent so the hand reads as a "shape",
//     not just a stick figure
//   • when a hand is PINCHING, dots flip to an accent colour + the
//     thumb–index bone gets a brighter accent stroke so users see the
//     gesture they're making at a glance
//   • when TWO HANDS are pinching simultaneously (the project's zoom /
//     pan gesture), a thin line is drawn between the two palm centres
//     so users see the two-hand link
//
// All drawing is Canvas2D on a single overlay canvas sized to the
// webcam preview. The video itself uses `transform: scaleX(-1)` to
// mirror the feed — we apply the same mirror to our X coords so the
// skeleton tracks the visible hand rather than drawing on the wrong
// side. Z-coord is ignored (no depth shading) for visual cleanliness.
// ---------------------------------------------------------------------------

// MediaPipe HandLandmarker bone topology — pairs of landmark indices
// to connect with a line. Reference:
//   https://developers.google.com/mediapipe/solutions/vision/hand_landmarker
const BONES = [
  // Thumb chain
  [0, 1], [1, 2], [2, 3], [3, 4],
  // Index chain
  [0, 5], [5, 6], [6, 7], [7, 8],
  // Middle chain
  [9, 10], [10, 11], [11, 12],
  // Ring chain
  [13, 14], [14, 15], [15, 16],
  // Pinky chain
  [0, 17], [17, 18], [18, 19], [19, 20],
  // Palm crossbars between finger bases
  [5, 9], [9, 13], [13, 17],
];

// Palm polygon vertices (closed) — wrist + each finger base, going CCW.
// Shaded translucent so the hand reads as a solid "shape" rather than
// a stick figure.
const PALM_FILL = [0, 5, 9, 13, 17];

// Strict monochrome — SplatGarden is a single-hue grayscale design
// (see the top-of-file note in style.css). Active / pinch states are
// expressed via BRIGHTNESS shifts (alpha + glow) rather than hue
// shifts, so the overlay reads as part of the same UI vocabulary as
// the rest of the panels.
const COLOR_BONE_BASE   = "rgba(255, 255, 255, 0.45)";
const COLOR_BONE_ACCENT = "rgba(255, 255, 255, 0.95)";   // pinch highlight (thumb-index) — brighter, not coloured
const COLOR_DOT_BASE    = "rgba(255, 255, 255, 0.85)";
const COLOR_DOT_PINCH   = "rgba(255, 255, 255, 1.0)";     // pure white + larger glow
const COLOR_PALM_FILL   = "rgba(255, 255, 255, 0.04)";
const COLOR_TWO_HAND    = "rgba(255, 255, 255, 0.55)";   // grayscale dashed link, not yellow
const COLOR_GLOW        = "rgba(255, 255, 255, 0.35)";

export class HandLandmarksOverlay {
  /**
   * @param {object} opts
   * @param {HTMLElement}      opts.mountEl   container that ALSO holds the <video>
   *                                          (we size relative to it)
   * @param {HTMLVideoElement} opts.videoEl   the live webcam <video> we're overlaying
   * @param {boolean}          [opts.mirrorX] mirror X coords (default true, matches our CSS scaleX(-1))
   */
  constructor({ mountEl, videoEl, mirrorX = true }) {
    this.mountEl  = mountEl;
    this.videoEl  = videoEl;
    this.mirrorX  = mirrorX;
    this.snapshot = null;   // last hands array from HandController.onHandsUpdate
    this._raf     = 0;
    this._init();
  }

  _init() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "hand-overlay-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    this.mountEl.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    this._sizeCanvas();
    this._onResize = () => this._sizeCanvas();
    window.addEventListener("resize", this._onResize);
    // Re-size when the panel itself changes layout (e.g. user collapses
    // / expands #hand-panel which changes #hand-preview-wrap dims).
    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => this._sizeCanvas());
      this._ro.observe(this.mountEl);
    }
    this._raf = requestAnimationFrame(this._tick);
  }

  _sizeCanvas() {
    const r   = this.mountEl.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width  = Math.max(1, Math.round(r.width  * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width  = r.width  + "px";
    this.canvas.style.height = r.height + "px";
    this._dpr = dpr;
    this._cssW = r.width;
    this._cssH = r.height;
  }

  /** Called by HandController via onHandsUpdate — pass the snapshot through. */
  update(snapshot) { this.snapshot = snapshot; }

  _tick = () => {
    this._draw();
    this._raf = requestAnimationFrame(this._tick);
  };

  _draw() {
    const ctx = this.ctx;
    const w = this._cssW || 0;
    const h = this._cssH || 0;
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const snap = this.snapshot;
    if (!snap) return;
    const present = snap.filter(s => s.present && s.landmarks);
    if (present.length === 0) return;

    // Project a normalized landmark (0..1) into the canvas's pixel space,
    // applying the mirror flip on X to match the video's scaleX(-1).
    const px = (lm) => ({
      x: (this.mirrorX ? (1 - lm.x) : lm.x) * w,
      y: lm.y * h,
    });

    // ---- Per-hand layers ----------------------------------------------
    for (const hand of present) {
      const lm = hand.landmarks;
      const isPinch = !!hand.pinching;

      // 1. Palm fill — soft translucent polygon under the bones.
      ctx.beginPath();
      const palm0 = px(lm[PALM_FILL[0]]);
      ctx.moveTo(palm0.x, palm0.y);
      for (let i = 1; i < PALM_FILL.length; i++) {
        const p = px(lm[PALM_FILL[i]]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fillStyle = COLOR_PALM_FILL;
      ctx.fill();

      // 2. Bones — base white at 1.5 px, plus an accent thumb-index
      //    bone when pinching to highlight the gesture.
      ctx.lineCap  = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = COLOR_BONE_BASE;
      ctx.lineWidth   = 1.6;
      for (const [a, b] of BONES) {
        // Skip the 3-4 thumb-tip bone if we're going to redraw it accent
        if (isPinch && a === 3 && b === 4) continue;
        if (isPinch && a === 7 && b === 8) continue;
        const pa = px(lm[a]);
        const pb = px(lm[b]);
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }
      if (isPinch) {
        ctx.strokeStyle = COLOR_BONE_ACCENT;
        ctx.lineWidth   = 2.4;
        // Thumb tip segment + index tip segment in accent so the
        // pinching fingers visibly light up.
        for (const [a, b] of [[3, 4], [7, 8]]) {
          const pa = px(lm[a]);
          const pb = px(lm[b]);
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
        }
        // Plus a connecting line from thumb tip → index tip so the
        // pinch reads as a closed loop (matches the reference visuals
        // where pinch fingers are wired together).
        const pt = px(lm[4]);
        const pi = px(lm[8]);
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(pi.x, pi.y);
        ctx.stroke();
      }

      // 3. Landmark dots — solid + glow.
      const dotR = 3.3;
      ctx.fillStyle = isPinch ? COLOR_DOT_PINCH : COLOR_DOT_BASE;
      ctx.shadowColor = COLOR_GLOW;
      ctx.shadowBlur  = isPinch ? 10 : 5;
      for (let i = 0; i < lm.length; i++) {
        const p = px(lm[i]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    // ---- Two-hand link — when BOTH hands are pinching, draw a thin
    //      line between the two palm centres so users see the dual-hand
    //      gesture (zoom / pan in 2-Hand mode).
    if (present.length === 2 && present[0].pinching && present[1].pinching) {
      const PALM_CENTER = 9;   // middle MCP, closest to true palm centre
      const a = px(present[0].landmarks[PALM_CENTER]);
      const b = px(present[1].landmarks[PALM_CENTER]);
      ctx.strokeStyle = COLOR_TWO_HAND;
      ctx.lineWidth   = 1.6;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // Distance readout — small mono caption above the midpoint, hints
      // that pinch-distance is what drives the zoom.
      const dx = a.x - b.x, dy = a.y - b.y;
      const d  = Math.hypot(dx, dy);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      ctx.font = '10px "JetBrains Mono", "SF Mono", ui-monospace, monospace';
      ctx.fillStyle = COLOR_TWO_HAND;
      ctx.textAlign = "center";
      ctx.fillText(`${Math.round(d)}px`, mx, my - 8);
    }
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener("resize", this._onResize);
    this._ro?.disconnect();
    this.canvas?.remove();
    this.canvas = null;
  }
}
