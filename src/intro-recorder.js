// ---------------------------------------------------------------------------
// IntroRecorder — captures the auto-played opening cinematic to a .webm
// file. The WebGL canvas only holds the 3D scene; the intro overlay text
// (Hero title + lower-third phase callouts + bottom progress strip) lives
// in the DOM and isn't part of the canvas stream, so we composite both
// into a 2D canvas every frame and feed THAT canvas's stream to
// MediaRecorder. The overlay drawing here mirrors src/intro-overlay.js
// (PHASES timings + style.css visuals) so the export reads identically to
// what the user saw.
//
// Lifecycle:
//   1. start()           — sizes the composite canvas to the WebGL backing
//                          buffer, wires up MediaRecorder, kicks the rAF
//                          composite loop.
//   2. setIntroState(t, playing)
//                        — main.js calls this from __camMoveTick each frame
//                          so we know what overlay state to draw.
//   3. stop()            — awaits the final dataavailable, returns the Blob.
//   4. download(blob)    — saves as .webm via an anchor click.
// ---------------------------------------------------------------------------

// These two structures intentionally mirror src/intro-overlay.js so any
// future edit to phase copy / timing happens in lock-step. If you change
// one, change both.
const HERO = {
  text:    "SplatGarden",
  sub:     "A 3D Gaussian Splatting asset showcase",
  inAt:    0.005,
  holdTo:  0.13,
  outAt:   0.17,
};

const PHASES = [
  { at: 0.02, until: 0.25, eyebrow: "CAPTURE", text: "Captured in Unreal Engine" },
  { at: 0.27, until: 0.50, eyebrow: "POSE",    text: "990 camera poses solved with COLMAP" },
  { at: 0.52, until: 0.75, eyebrow: "TRAIN",   text: "3 million Gaussians optimized in Postshot" },
  { at: 0.77, until: 0.99, eyebrow: "RENDER",  text: "Real-time WebGL playback via Spark" },
];

const FADE = 0.025;
const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };

// First mime type the browser actually supports. MP4 (H.264) is tried
// first because the resulting file plays natively in QuickTime / Premiere
// / iOS Photos / Final Cut without a re-encode step; WebM is the
// fallback for browsers that still lack MediaRecorder MP4 support
// (Firefox as of late 2025, older Chromium).
function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    "video/mp4;codecs=avc1.42E01E",   // H.264 baseline profile
    "video/mp4;codecs=avc1",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const m of candidates) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* */ }
  }
  return null;
}

// File extension implied by a chosen mime type. Mapping is exact — we
// only call this with strings pickMime() returned, so unknown values
// fall back conservatively to .webm.
function extForMime(mime) {
  if (!mime) return "webm";
  if (mime.startsWith("video/mp4")) return "mp4";
  return "webm";
}

// Fixed export resolutions. Phone gets 9:16 portrait, everything else
// (iPad / laptop / desktop) gets 16:9 landscape — clean standard aspects
// for sharing / social / video editing, not whatever the live viewport
// happens to be.
const EXPORT_LANDSCAPE = { w: 1920, h: 1080 };
const EXPORT_PORTRAIT  = { w: 1080, h: 1920 };

// Phone detection mirrors the IS_PHONE rule in main.js (touch + narrow
// viewport), evaluated at export time so a tablet rotated mid-session
// still gets the right aspect.
function detectPhone() {
  try {
    const isTouch = matchMedia("(hover: none) and (pointer: coarse)").matches;
    return isTouch && window.innerWidth < 768;
  } catch { return false; }
}

export class IntroRecorder {
  constructor({ canvas, fps = 60, bitrate = 16_000_000 } = {}) {
    this.srcCanvas = canvas;
    this.dst       = document.createElement("canvas");
    this.ctx       = this.dst.getContext("2d");
    this.fps       = fps;
    this.bitrate   = bitrate;

    // Frame-state, updated from main.js every tick
    this.tNorm   = 0;
    this.playing = false;

    this.recording = false;
    this.stream    = null;
    this.recorder  = null;
    this.chunks    = [];
    this._rafId    = 0;
    // Output dimensions are fixed per export (set in start()); using a
    // sane default here so any code that reads them before start works.
    this.outW = EXPORT_LANDSCAPE.w;
    this.outH = EXPORT_LANDSCAPE.h;
  }

  static isSupported() { return typeof MediaRecorder !== "undefined" && pickMime() !== null; }

  setIntroState(tNorm, playing) {
    this.tNorm   = tNorm;
    this.playing = playing;
  }

  start() {
    if (this.recording) return;
    if (!IntroRecorder.isSupported()) {
      console.warn("[IntroRecorder] MediaRecorder not supported in this browser.");
      return;
    }
    // Pick a fixed output aspect — phones get portrait 9:16, anything else
    // (iPad / web) gets landscape 16:9. Evaluated per-start so a mid-session
    // device rotation still produces the expected file.
    const target = detectPhone() ? EXPORT_PORTRAIT : EXPORT_LANDSCAPE;
    this.outW = target.w;
    this.outH = target.h;
    this.dst.width  = this.outW;
    this.dst.height = this.outH;
    this.chunks = [];
    this.stream = this.dst.captureStream(this.fps);

    const mimeType = pickMime();
    // Remember the mime so stop() builds the Blob with the matching type
    // and download() picks the right file extension.
    this.mimeType = mimeType;
    this.recorder = new MediaRecorder(this.stream, {
      mimeType,
      videoBitsPerSecond: this.bitrate,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(250);     // flush a chunk every 250 ms
    this.recording = true;
    this._tick();
  }

  // Compose the live WebGL canvas into the fixed-aspect output. We use
  // "cover" fit (scale source to fully fill dst, center-crop the
  // overhang) rather than "contain" (letterbox) because a recording with
  // black bars looks worse than a slight edge crop on a cinematic that's
  // composed roughly around the subject.
  _tick = () => {
    if (!this.recording) return;
    const ctx = this.ctx;
    // Black fill so any edge that ends up uncovered (defensive — cover
    // shouldn't leave gaps) doesn't show transparency artifacts.
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.outW, this.outH);

    const srcW = this.srcCanvas.width;
    const srcH = this.srcCanvas.height;
    if (srcW > 0 && srcH > 0) {
      const scale = Math.max(this.outW / srcW, this.outH / srcH);
      const drawW = srcW * scale;
      const drawH = srcH * scale;
      const dx = (this.outW - drawW) / 2;
      const dy = (this.outH - drawH) / 2;
      ctx.drawImage(this.srcCanvas, dx, dy, drawW, drawH);
    }

    // Overlay only while the cinematic is playing — once stopped we
    // still keep recording for the lens-fade tail, but the overlay should
    // be gone (matches what the live user sees).
    if (this.playing) this._drawOverlay();
    this._rafId = requestAnimationFrame(this._tick);
  };

  // ---------------------------------------------------------------------
  // Overlay drawing — replicates the DOM intro-overlay in canvas 2D so
  // the recorded video matches the live appearance. Dimensions are
  // computed against the fixed export resolution (no devicePixelRatio
  // multiplier) so a 1920x1080 export and a 1080x1920 export each render
  // type at a size that reads correctly for the target frame.
  // ---------------------------------------------------------------------
  _drawOverlay() {
    const ctx = this.ctx;
    const w   = this.outW;
    const h   = this.outH;
    const t   = this.tNorm;
    // Use the shorter axis as the reference for typography so portrait
    // and landscape exports use comparable text scale.
    const ref = Math.min(w, h);

    // -------- HERO (centered title + sub) --------
    let heroAlpha = 0;
    if      (t < HERO.inAt)   heroAlpha = 0;
    else if (t < HERO.holdTo) heroAlpha = smooth((t - HERO.inAt)  / FADE);
    else if (t < HERO.outAt)  heroAlpha = 1;
    else                      heroAlpha = 1 - smooth((t - HERO.outAt) / FADE);
    heroAlpha = Math.max(0, Math.min(1, heroAlpha));

    if (heroAlpha > 0.001) {
      ctx.save();
      ctx.globalAlpha   = heroAlpha;
      ctx.shadowColor   = "rgba(0,0,0,0.75)";
      ctx.shadowBlur    = Math.round(ref * 0.025);
      ctx.shadowOffsetY = 2;
      ctx.textBaseline  = "alphabetic";

      const titleSize = Math.round(ref * 0.085);
      const cx        = w / 2;
      const cy        = h * 0.38;

      // Hero title
      ctx.textAlign = "center";
      ctx.fillStyle = "#ffffff";
      ctx.font      = `300 ${titleSize}px Inter, "SF Pro Text", "Segoe UI", sans-serif`;
      ctx.fillText(HERO.text, cx, cy);

      // Sub (uppercase, wide tracking)
      const subSize = Math.max(11, Math.round(ref * 0.013));
      ctx.shadowBlur = Math.round(ref * 0.015);
      ctx.fillStyle  = "rgba(255,255,255,0.78)";
      ctx.font       = `400 ${subSize}px "JetBrains Mono", monospace`;
      this._fillTracked(ctx, HERO.sub.toUpperCase(),
        cx, cy + titleSize * 0.55 + 14, 0.36, "center");

      ctx.restore();
    }

    // -------- PHASE callout (lower-third, with vertical white bar) --------
    let activeIdx  = -1;
    let phaseAlpha = 0;
    for (let i = 0; i < PHASES.length; i++) {
      const p = PHASES[i];
      if (t >= p.at - FADE && t <= p.until + FADE) {
        activeIdx = i;
        if      (t < p.at)    phaseAlpha = smooth((t - (p.at - FADE)) / FADE);
        else if (t > p.until) phaseAlpha = 1 - smooth((t - p.until)    / FADE);
        else                  phaseAlpha = 1;
        break;
      }
    }

    if (activeIdx >= 0 && phaseAlpha > 0.001) {
      const p = PHASES[activeIdx];

      const baseX = Math.round(w * 0.06);
      const baseY = Math.round(h - h * 0.10);     // 10% from bottom
      const eyebrowSize   = Math.max(11, Math.round(ref * 0.014));
      const phaseTextSize = Math.max(22, Math.round(ref * 0.030));
      const innerGap = Math.round(ref * 0.012);
      const blockH = eyebrowSize + innerGap + phaseTextSize * 1.15;
      const blockTop = baseY - blockH;

      ctx.save();
      ctx.globalAlpha   = phaseAlpha;
      ctx.shadowColor   = "rgba(0,0,0,0.80)";
      ctx.shadowBlur    = Math.round(ref * 0.018);
      ctx.shadowOffsetY = 2;

      // Vertical bar on left edge of the block
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(baseX, blockTop, 2, blockH);

      const textX = baseX + 14;
      // Eyebrow
      ctx.fillStyle    = "rgba(255,255,255,0.82)";
      ctx.font         = `500 ${eyebrowSize}px "JetBrains Mono", monospace`;
      ctx.textBaseline = "top";
      this._fillTracked(ctx, p.eyebrow, textX, blockTop, 0.36, "left");

      // Phase text
      ctx.fillStyle    = "#ffffff";
      ctx.font         = `300 ${phaseTextSize}px Inter, sans-serif`;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(p.text, textX, blockTop + eyebrowSize + innerGap + phaseTextSize);

      ctx.restore();
    }

    // -------- Bottom progress bar --------
    ctx.save();
    const barH = 2;
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    ctx.fillRect(0, h - barH, w, barH);

    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "rgba(255,255,255,0.45)");
    grad.addColorStop(1, "rgba(255,255,255,0.95)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, h - barH, w * Math.max(0, Math.min(1, t)), barH);
    ctx.restore();
  }

  // Letter-spaced text — uses ctx.letterSpacing when available (Chrome 99+),
  // falls back to per-character drawing for older browsers.
  _fillTracked(ctx, text, x, y, trackEm, align = "left") {
    if (!text) return;
    const fontMatch = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
    const fontSize  = fontMatch ? parseFloat(fontMatch[1]) : 16;

    if ("letterSpacing" in ctx) {
      const prev = ctx.letterSpacing;
      ctx.letterSpacing = `${fontSize * trackEm}px`;
      ctx.textAlign     = align;
      ctx.fillText(text, x, y);
      ctx.letterSpacing = prev || "0px";
      return;
    }

    // Manual fallback: measure each char, place individually
    ctx.textAlign = "left";
    const spacing = fontSize * trackEm;
    const chars   = [...text];
    const widths  = chars.map(ch => ctx.measureText(ch).width);
    const totalW  = widths.reduce((s, w) => s + w, 0) + spacing * (chars.length - 1);
    let cursor;
    if      (align === "center") cursor = x - totalW / 2;
    else if (align === "right")  cursor = x - totalW;
    else                         cursor = x;
    for (let i = 0; i < chars.length; i++) {
      ctx.fillText(chars[i], cursor, y);
      cursor += widths[i] + spacing;
    }
  }

  async stop() {
    if (!this.recording || !this.recorder) return null;
    this.recording = false;
    cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    return new Promise((resolve) => {
      const rec = this.recorder;
      rec.onstop = () => {
        // Use the recorder's actual chosen mime (Blob container should
        // match the MP4 / WebM payload bytes the chunks contain).
        const blob = new Blob(this.chunks, { type: this.mimeType || "video/webm" });
        this.recorder = null;
        this.stream?.getTracks().forEach((tr) => tr.stop());
        this.stream = null;
        resolve(blob);
      };
      try { rec.stop(); } catch (e) { resolve(null); }
    });
  }

  download(blob, baseName = "splatgarden-intro") {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    const ts  = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    // Extension follows the actual container the encoder produced — .mp4
    // when MediaRecorder picked an MP4 mime, .webm otherwise.
    const ext = extForMime(blob.type || this.mimeType);
    a.href     = url;
    a.download = `${baseName}-${ts}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}
