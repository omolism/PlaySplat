// ---------------------------------------------------------------------------
// Profiler — per-phase frame-time breakdown.
//
// CPU-side wall-clock timing wrapped around each render phase via begin/end.
// (Strictly more honest than `dt`-based fps: dt is clamped at 50ms so a
// dropped frame looks normal in the FPS counter — wall-clock catches it.)
//
// True GPU time would need EXT_disjoint_timer_query_webgl2 — its async
// 2-3-frame readback delay is fine for averaged display but adds ~100
// lines of GL plumbing per phase. v1 here is JS-side; v2 can add GPU
// queries as a sub-row.
//
// Toggle: press P, or via instance.toggle().
// ---------------------------------------------------------------------------

const UPDATE_HZ_MS = 250;     // refresh DOM 4× / sec to read calmly
const SAMPLE_WINDOW = 30;     // ~0.5s rolling avg @ 60 fps

// Labels named for what they actually do in the PlaySplat render flow,
// not for generic engine phases. Frame work order:
//   JS UPDATE       — controls.update + camera-move tick + effects uniforms
//   FIELD+PARTICLES — velocity field convolve/advect + GPGPU particle step
//   SPLAT RENDER    — Spark's 3DGS rasterisation (+ post-FX composer if on)
//   GIZMOS          — particle scene + Tech-Spec overlay (frustums, labels)
//   PANELS          — DOM updates for the Pipeline HUD, hover hotspots, etc.
const PHASE_DEFS = [
  { key: "logic",   label: "JS UPDATE" },
  { key: "step",    label: "FIELD + PARTICLES" },
  { key: "compose", label: "SPLAT RENDER" },
  { key: "overlay", label: "GIZMOS" },
  { key: "hud",     label: "PANELS" },
];

class Ring {
  constructor(n) { this.buf = new Float32Array(n); this.i = 0; this.n = 0; this.max = 0; }
  push(v) {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.buf.length;
    this.n = Math.min(this.n + 1, this.buf.length);
    if (v > this.max) this.max = v;
  }
  avg() {
    if (this.n === 0) return 0;
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.buf[i];
    return s / this.n;
  }
  decayMax() {
    // Slowly decay the rolling max so spikes fade out of the display.
    this.max *= 0.995;
  }
}

export class Profiler {
  constructor({ mountEl = document.body } = {}) {
    this.open    = false;
    this._lastUI = 0;
    this._frame  = new Ring(SAMPLE_WINDOW);
    // True frame-to-frame delta (rAF cadence). The FRAME row above only
    // measures JS wall-clock INSIDE the frame — on a GPU-bound scene
    // that reads 0.5 ms while the real presentation rate is 30 fps,
    // because the GPU back-pressure shows up as rAF spacing, not as JS
    // time. FPS here is the number that matters for benchmarking.
    this._delta  = new Ring(SAMPLE_WINDOW);
    this._lastFrameT = 0;
    this._phases = new Map();
    for (const p of PHASE_DEFS) this._phases.set(p.key, new Ring(SAMPLE_WINDOW));

    this._fStart = 0;
    this._pStart = 0;
    this._pCurr  = null;

    this.el = document.createElement("div");
    this.el.id = "profiler";
    this.el.innerHTML = `
      <div class="prof-title">
        <span class="dot"></span>
        <span class="t">PROFILER</span>
        <span class="prof-key">P</span>
      </div>
      <div class="prof-body">
        <div class="prof-frame">
          <div class="prof-row prof-frame-row">
            <span class="k">FPS</span>
            <span class="v" data-k="fps">—</span>
          </div>
          <div class="prof-row">
            <span class="k">FRAME (JS)</span>
            <span class="v" data-k="frame">— ms</span>
          </div>
          <div class="prof-row">
            <span class="k">MAX</span>
            <span class="v" data-k="frameMax">— ms</span>
          </div>
        </div>
        <div class="prof-divider"></div>
        <div class="prof-phases">
          ${PHASE_DEFS.map(p => `
            <div class="prof-phase" data-phase="${p.key}">
              <div class="prof-phase-label">
                <span class="k">${p.label}</span>
                <span class="v" data-k="ms">— ms</span>
              </div>
              <div class="prof-phase-bar">
                <span class="fill" data-k="bar"></span>
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    `;
    mountEl.appendChild(this.el);

    window.addEventListener("keydown", (e) => {
      if (e.key === "p" || e.key === "P") {
        const tag = e.target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
        this.toggle();
      }
    });

    // Benchmark hook: `?profiler=1` (or `&profiler`) auto-opens the panel
    // at boot. Phones have no keyboard for the P toggle, and the bottom
    // toolbar fps readout is CSS-hidden under body.mobile — this param is
    // how mobile benchmark runs read their numbers. Harmless on desktop.
    try {
      if (new URLSearchParams(location.search).has("profiler")) this.openOverlay();
    } catch { /* ancient browsers without URLSearchParams — ignore */ }
  }

  toggle()  { this.open ? this.close() : this.openOverlay(); }
  openOverlay() { this.open = true;  this.el.classList.add("show"); }
  close()       { this.open = false; this.el.classList.remove("show"); }

  // ---- timing API --------------------------------------------------------
  beginFrame() {
    const now = performance.now();
    // Frame-to-frame delta — the REAL presentation cadence including GPU
    // back-pressure (rAF spacing), unlike the JS wall-clock below.
    if (this._lastFrameT > 0) this._delta.push(now - this._lastFrameT);
    this._lastFrameT = now;
    this._fStart = now;
  }
  endFrame() {
    const dt = performance.now() - this._fStart;
    this._frame.push(dt);
    if (performance.now() - this._lastUI > UPDATE_HZ_MS) {
      this._lastUI = performance.now();
      this._updateUI();
    }
    this._frame.decayMax();
    for (const r of this._phases.values()) r.decayMax();
  }
  begin(key) {
    this._pCurr  = key;
    this._pStart = performance.now();
  }
  end() {
    if (!this._pCurr) return;
    const r = this._phases.get(this._pCurr);
    if (r) r.push(performance.now() - this._pStart);
    this._pCurr = null;
  }
  // Auto-end the previous phase and begin the next — saves writing
  // explicit end() calls between adjacent measured spans.
  mark(key) {
    if (this._pCurr) this.end();
    this.begin(key);
  }

  _updateUI() {
    if (!this.open) return;     // skip DOM updates when hidden — cheap

    const dAvg = this._delta.avg();
    this._setText("fps", dAvg > 0 ? (1000 / dAvg).toFixed(1) : "—");

    const fAvg = this._frame.avg();
    const fMax = this._frame.max;
    this._setText("frame",    fAvg.toFixed(1) + " ms");
    this._setText("frameMax", fMax.toFixed(1) + " ms");

    // Per-phase bars are normalised to the frame avg so the visual mix
    // reads like a stacked breakdown.
    for (const p of PHASE_DEFS) {
      const ring = this._phases.get(p.key);
      const ms   = ring.avg();
      const row  = this.el.querySelector(`[data-phase="${p.key}"]`);
      if (!row) continue;
      row.querySelector('[data-k="ms"]').textContent = ms.toFixed(1) + " ms";
      const pct = fAvg > 0 ? (ms / fAvg) * 100 : 0;
      const fill = row.querySelector('[data-k="bar"]');
      fill.style.width = `${Math.min(pct, 100).toFixed(1)}%`;
      // Bar colour is set in CSS (neutral white); no cost-based tint.
    }
  }

  _setText(key, value) {
    const el = this.el.querySelector(`[data-k="${key}"]`);
    if (el) el.textContent = value;
  }
}
