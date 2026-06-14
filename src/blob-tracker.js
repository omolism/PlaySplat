// ---------------------------------------------------------------------------
// BlobTracker — CV-style "object tracking" HUD overlay (the artkit.cc
// "Baby Track" aesthetic). A click drops a tracker onto the 3D hit point:
// a bounding box framed in the motion-graphics detection style, tagged with
// a normalized "confidence" label, filled with CRT scanlines, and joined to
// the other live trackers by thin connector lines.
//
// 3D-anchored: each blob stores the WORLD-space hit point and re-projects to
// screen every frame, so the boxes stay locked to the scene as the camera
// orbits — a true 3D tracker, not a screen-space splash. Drawn on a 2D
// canvas overlaid above the WebGL viewport (boxes, text, connectors, and
// glow are all far cheaper and crisper in canvas 2D than in a shader pass).
//
// Monochrome per the project rule: white at varying alpha, no hue.
// ---------------------------------------------------------------------------

import * as THREE from "three";

// Legacy "confidence" label: multiples of 1/7, so they read as
// 0.1429 / 0.2857 / ... like a quantized detector score. Kept as one
// selectable label mode; the default is now a real monotonic track id.
const labelFor = (id) => (id / 7).toFixed(4);

// Exports use a clean sans (never a monospace) so the overlay reads as a
// refined data-graphic that sits inside the scene rather than a terminal HUD.
const SANS = '"Helvetica Neue", "Inter", Arial, sans-serif';

export class BlobTracker {
  /**
   * @param {object} opts
   * @param {THREE.Camera} opts.camera
   * @param {HTMLElement}  [opts.mountEl]
   */
  constructor({ camera, mountEl = document.body }) {
    this.camera = camera;
    this.blobs  = [];       // { world, t, t0, size, id, track, jx, jy }
    this._elapsed = 0;
    this._labelSeq = 0;     // cycles 1..8 (confidence mode only)
    this._trackSeq = 0;     // monotonic, never recycled — the real track id

    this.params = {
      enable:       true,    // the requested click feedback — on by default
      boxSize:      120,     // base box edge in CSS px (jittered per blob)
      lifetime:     3.6,     // seconds of the bright "active" phase
      // Persistence reframes the tracker as a trace rather than a blip:
      //   0   = ephemeral — the box fades fully and is removed (a blip).
      //   1   = enduring  — after the bright phase it settles to a faint
      //         residual and STAYS, so every visitor's touch accumulates on
      //         the garden as a collective map of where people looked.
      //   0<p<1 = it lingers, but dimmer.
      // The bright spawn pulse is always present; persistence only governs
      // what remains afterward. In an exhibition, raise maxBlobs so the
      // accumulation has room to build.
      persistence:  0.6,
      maxBlobs:     24,      // FIFO cap (raise for exhibition accumulation)
      connections:  true,    // draw connector lines between trackers
      scanlines:    true,    // CRT scanline fill inside each box
      glow:         true,    // soft glow on box edges + connectors
      label:        true,    // draw the per-box readout tag
      // What the readout shows. Real session data beats a decorative score:
      //   "id"         monotonic track id (#001…) — also the most authentic
      //                to the object-tracker aesthetic; the default.
      //   "time"       session timestamp at spawn (mm:ss) — turns the
      //                accumulating traces into a visible timeline.
      //   "age"        live seconds since spawn — reads as memory/decay.
      //   "coords"     world-space x y z — the "measurement" half of the work.
      //   "confidence" the legacy fake detector score (0.1429…).
      labelMode:    "id",
    };
    // Peak alpha of a fully-persistent residual trace — visible as history
    // without competing with freshly-spawned (bright) boxes.
    this._RESIDUAL = 0.38;

    // Full-screen overlay canvas: above the WebGL viewport, below the UI
    // panels, click-through so it never eats interactions.
    this.canvas = document.createElement("canvas");
    this.canvas.id = "blob-tracker";
    Object.assign(this.canvas.style, {
      position: "fixed", inset: "0", width: "100%", height: "100%",
      pointerEvents: "none", zIndex: "3",
    });
    mountEl.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this._resize();
    this._onResize = () => this._resize();
    window.addEventListener("resize", this._onResize);

    // scratch
    this._v = new THREE.Vector3();
    this._cam = new THREE.Vector3();
    this._tmp = new THREE.Vector3();   // reused for projecting logged points

    // Full interaction history (world-space hit points), independent of the
    // display FIFO above — this is the data the exported heatmap draws from,
    // so it can outlive any single tracker box. Capped to keep the export
    // pass bounded; in an exhibition this is the running record of every
    // touch the garden received.
    this.heatPoints = [];
    this._HEAT_CAP = 5000;
    // Structured interaction log (timestamp + coords + context) for CSV.
    this.log = [];
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._dpr = dpr;
    this._w = window.innerWidth;
    this._h = window.innerHeight;
    this.canvas.width  = Math.round(this._w * dpr);
    this.canvas.height = Math.round(this._h * dpr);
  }

  setEnabled(on) {
    this.params.enable = !!on;
    if (!on) { this.blobs.length = 0; this._clear(); }
  }

  // Wipe the accumulated traces AND the heatmap history — the exhibition
  // "reset the canvas" gesture.
  clearAll() { this.blobs.length = 0; this.heatPoints.length = 0; this.log.length = 0; this._clear(); }

  // Click → drop a tracker at the world-space hit point. `meta` carries the
  // interaction context (active effect + which representations were visible)
  // so the exported CSV is a real session log, not just coordinates.
  addBlob(worldPos, meta = {}) {
    if (!this.params.enable || !worldPos) return;
    // Record into the heatmap history (kept even after the box retires).
    this.heatPoints.push(worldPos.clone());
    if (this.heatPoints.length > this._HEAT_CAP) this.heatPoints.shift();
    this._labelSeq = (this._labelSeq % 8) + 1;   // 1..8 → 1/7 .. 8/7
    const track = ++this._trackSeq;              // monotonic catalogue id
    // Structured interaction record for the CSV export (independent of the
    // display FIFO; capped with the heat history).
    this.log.push({
      t:      this._elapsed,
      track,
      x:      worldPos.x, y: worldPos.y, z: worldPos.z,
      effect: meta.effect ?? "",
      splat:  meta.splat ? 1 : 0,
      quad:   meta.quad  ? 1 : 0,
      voxel:  meta.voxel ? 1 : 0,
      label:  labelFor(this._labelSeq),
    });
    if (this.log.length > this._HEAT_CAP) this.log.shift();
    this.blobs.push({
      world: worldPos.clone(),
      t: 0,
      t0: this._elapsed,
      id: this._labelSeq,
      track,
      // per-blob size jitter + small screen offset so stacked clicks read
      // as distinct boxes rather than one redrawn frame (like the reference,
      // where overlapping detections fan out at slightly different scales).
      size: this.params.boxSize * (0.7 + Math.random() * 0.7),
      jx: (Math.random() - 0.5) * 40,
      jy: (Math.random() - 0.5) * 40,
    });
    if (this.blobs.length > this.params.maxBlobs) this.blobs.shift();
  }

  _clear() {
    if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // The text shown on each tracker box, per params.labelMode. Carries real
  // session data (track id / spawn time / live age / world coords) rather
  // than a decorative score; see the labelMode notes in the constructor.
  _labelText(b) {
    switch (this.params.labelMode) {
      case "time":       return this._fmtTime(b.t0);
      case "age":        return `${(this._elapsed - b.t0).toFixed(1)}s`;
      case "coords":     return `${b.world.x.toFixed(1)} ${b.world.y.toFixed(1)} ${b.world.z.toFixed(1)}`;
      case "confidence": return labelFor(b.id);
      case "id":
      default:           return `#${String(b.track).padStart(3, "0")}`;
    }
  }

  // Session time as mm:ss for the "time" label mode.
  _fmtTime(s) {
    const m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }

  // Project a world point to CSS-pixel screen coords; returns null if the
  // point is behind the camera (so trackers vanish when you orbit past them).
  _project(world) {
    this._cam.copy(world).applyMatrix4(this.camera.matrixWorldInverse);
    if (this._cam.z > -0.05) return null;        // at/behind the camera plane
    this._v.copy(world).project(this.camera);
    return { x: (this._v.x * 0.5 + 0.5) * this._w, y: (-this._v.y * 0.5 + 0.5) * this._h };
  }

  // Per-frame: advance lifetimes, project, draw. Called from the render loop.
  update(dt) {
    if (!this.params.enable) return;
    this._elapsed += dt;
    const life = Math.max(this.params.lifetime, 0.1);
    const persist = Math.max(0, Math.min(1, this.params.persistence));
    const residual = persist * this._RESIDUAL;

    // Advance time on every blob. Cull only the EPHEMERAL ones once faded —
    // persistent traces (residual > 0) are kept and the FIFO cap (enforced
    // in addBlob) is the only thing that ever retires them.
    for (const b of this.blobs) b.t += dt;
    if (residual <= 0.001) this.blobs = this.blobs.filter(b => b.t < life);

    const ctx = this.ctx, dpr = this._dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this._w, this._h);
    if (!this.blobs.length) return;

    // Project all live blobs once; keep the on-screen ones for connectors.
    const pts = [];
    for (const b of this.blobs) {
      const p = this._project(b.world);
      if (!p) continue;
      const a = b.t / life;                                   // 0..1 progress
      // spawn pop (fast ease-in) then fade-out tail toward the residual floor
      const grow   = Math.min(a / 0.12, 1);
      const fade   = a > 0.72 ? 1 - (a - 0.72) / 0.28 : 1;
      const bright = Math.max(0, Math.min(1, grow * fade));
      // Persistent traces never drop below the residual level; ephemeral
      // ones (residual 0) fall to zero and get culled next frame.
      const alpha  = Math.max(bright, residual);
      const label  = this.params.label ? this._labelText(b) : "";
      pts.push({ x: p.x + b.jx, y: p.y + b.jy, s: b.size * (0.85 + 0.15 * grow), alpha, label });
    }
    if (!pts.length) return;

    // Connector lines first (under the boxes), chaining spawn order.
    if (this.params.connections && pts.length > 1) {
      ctx.lineWidth = 1;
      if (this.params.glow) { ctx.shadowColor = "rgba(255,255,255,0.6)"; ctx.shadowBlur = 4; }
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        ctx.strokeStyle = `rgba(255,255,255,${0.25 * Math.min(a.alpha, b.alpha)})`;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    // Boxes.
    for (const p of pts) this._drawBox(ctx, p);
  }

  _drawBox(ctx, p) {
    const h = p.s * 0.5;
    const x0 = p.x - h, y0 = p.y - h, sz = p.s;
    const a = p.alpha;

    // Scanline fill — clipped to the box, faint horizontal CRT lines.
    if (this.params.scanlines) {
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, y0, sz, sz); ctx.clip();
      ctx.strokeStyle = `rgba(255,255,255,${0.10 * a})`;
      ctx.lineWidth = 1;
      for (let y = y0; y < y0 + sz; y += 3) {
        ctx.beginPath(); ctx.moveTo(x0, y + 0.5); ctx.lineTo(x0 + sz, y + 0.5); ctx.stroke();
      }
      ctx.restore();
    }

    // Box border with corner emphasis (frame style).
    if (this.params.glow) { ctx.shadowColor = `rgba(255,255,255,${0.7 * a})`; ctx.shadowBlur = 6; }
    ctx.strokeStyle = `rgba(255,255,255,${0.85 * a})`;
    ctx.lineWidth = 1.25;
    ctx.strokeRect(x0, y0, sz, sz);
    ctx.shadowBlur = 0;

    // Corner ticks — short brighter segments at each corner.
    const tick = Math.max(8, sz * 0.14);
    ctx.strokeStyle = `rgba(255,255,255,${a})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    // TL
    ctx.moveTo(x0, y0 + tick); ctx.lineTo(x0, y0); ctx.lineTo(x0 + tick, y0);
    // TR
    ctx.moveTo(x0 + sz - tick, y0); ctx.lineTo(x0 + sz, y0); ctx.lineTo(x0 + sz, y0 + tick);
    // BR
    ctx.moveTo(x0 + sz, y0 + sz - tick); ctx.lineTo(x0 + sz, y0 + sz); ctx.lineTo(x0 + sz - tick, y0 + sz);
    // BL
    ctx.moveTo(x0 + tick, y0 + sz); ctx.lineTo(x0, y0 + sz); ctx.lineTo(x0, y0 + sz - tick);
    ctx.stroke();

    // Readout tag (track id / time / age / coords / confidence), baseline
    // just inside the top-right corner.
    if (this.params.label && p.label) {
      ctx.font = "11px ui-monospace, 'SF Mono', Menlo, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.fillText(p.label, x0 + sz - 5, y0 + 5);
    }
  }

  // Project every logged interaction (world → screen via the CURRENT camera)
  // in temporal order, each carrying its timestamp and context. Shared source
  // for both the PNG overlay and the HTML trajectory export. Falls back to the
  // bare heatPoints if the structured log is unavailable.
  _collectTrajectory() {
    const pts = [];
    const src = this.log.length ? this.log : this.heatPoints;
    for (const r of src) {
      const wp = (r instanceof THREE.Vector3) ? r : this._tmp.set(r.x, r.y, r.z);
      const p = this._project(wp);
      if (!p) continue;
      pts.push({ x: p.x, y: p.y, t: r.t ?? 0, track: r.track ?? 0, effect: r.effect ?? "" });
    }
    return pts;
  }

  // Summary statistics over the full interaction log (count, duration, rate,
  // spatial centroid/extent, per-effect tally) for the export captions.
  _sessionStats() {
    const rows = this.log, n = rows.length;
    if (!n) return { n: 0 };
    const dur = rows[n - 1].t - rows[0].t;
    const byEffect = {};
    let cx = 0, cy = 0, cz = 0;
    let xmin = Infinity, ymin = Infinity, zmin = Infinity, xmax = -Infinity, ymax = -Infinity, zmax = -Infinity;
    for (const r of rows) {
      byEffect[r.effect || "(none)"] = (byEffect[r.effect || "(none)"] || 0) + 1;
      cx += r.x; cy += r.y; cz += r.z;
      xmin = Math.min(xmin, r.x); xmax = Math.max(xmax, r.x);
      ymin = Math.min(ymin, r.y); ymax = Math.max(ymax, r.y);
      zmin = Math.min(zmin, r.z); zmax = Math.max(zmax, r.z);
    }
    cx /= n; cy /= n; cz /= n;
    const topEffects = Object.entries(byEffect).sort((a, b) => b[1] - a[1]).slice(0, 4);
    return { n, dur, ipm: dur > 0 ? n / (dur / 60) : 0,
      centroid: [cx, cy, cz], extent: [xmax - xmin, ymax - ymin, zmax - zmin], topEffects };
  }

  // Export the accumulated interaction history as a composed "interaction
  // field" PNG, projected through the CURRENT camera so it sits over the
  // garden the way the audience saw it. Beyond a density heatmap, it draws the
  // temporal TRAJECTORY connecting touches in order (a glowing comet route),
  // bright nodes with scattered telemetry labels, and framed corner data
  // panels — an operational-image keepsake rather than a clinical heatmap.
  // @param {object} opts
  // @param {HTMLCanvasElement} [opts.background] - the WebGL canvas to dim behind.
  // @param {number} [opts.scale] - supersampling factor for a crisp export.
  exportHeatmap({ background = null, returnCanvas = false, scale = 2 } = {}) {
    const pts = this._collectTrajectory();
    if (!pts.length) { window.__toast?.("No interactions to map yet"); return; }
    const S = Math.max(1, scale);
    const W = Math.round(this._w * S), H = Math.round(this._h * S);
    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const ctx = out.getContext("2d");
    const X = (p) => p.x * S, Y = (p) => p.y * S;

    // 1) Backdrop — dimmed, cooled scene (or deep space if none).
    ctx.fillStyle = "#05070a"; ctx.fillRect(0, 0, W, H);
    if (background) {
      try {
        ctx.drawImage(background, 0, 0, W, H);
        ctx.fillStyle = "rgba(5,8,12,0.66)"; ctx.fillRect(0, 0, W, H);
      } catch (e) { /* tainted/empty */ }
    }

    // 2) Density bloom — a single soft, sage-white halo per touch, low alpha,
    //    so density reads as a quiet luminance that belongs to the scene
    //    rather than a saturated blue/orange overlay.
    ctx.globalCompositeOperation = "lighter";
    const R = Math.max(26, Math.min(W, H) * 0.038);
    for (const p of pts) {
      const x = X(p), y = Y(p);
      const g = ctx.createRadialGradient(x, y, 0, x, y, R);
      g.addColorStop(0, "rgba(208,222,210,0.09)"); g.addColorStop(1, "rgba(208,222,210,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, R, 0, 7); ctx.fill();
    }

    // 3) Trajectory — delicate filaments between consecutive touches in time,
    //    near-white at low opacity, barely brightening toward the most recent.
    //    Hairline weight + faint glow so the web recedes into the field.
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.shadowColor = "rgba(225,235,225,0.45)"; ctx.shadowBlur = 1.5 * S;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], rec = i / pts.length;
      ctx.strokeStyle = `rgba(236,240,232,${(0.06 + rec * 0.16).toFixed(3)})`;
      ctx.lineWidth = (0.4 + rec * 0.55) * S;
      ctx.beginPath(); ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b)); ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = "source-over";

    // 4) Nodes — small soft points; every Nth gets a light reticle + a bare
    //    numeric tag set in sans, scattered like the reference field labels.
    const step = Math.max(1, Math.round(pts.length / 18));
    ctx.textBaseline = "alphabetic";
    ctx.letterSpacing = `${1 * S}px`;
    ctx.font = `${9 * S}px ${SANS}`;
    pts.forEach((p, i) => {
      const x = X(p), y = Y(p);
      ctx.fillStyle = "rgba(255,255,255,0.72)";
      ctx.beginPath(); ctx.arc(x, y, 1.3 * S, 0, 7); ctx.fill();
      if (i % step === 0) {
        ctx.strokeStyle = "rgba(224,232,220,0.3)"; ctx.lineWidth = 1 * S;
        ctx.strokeRect(x - 4 * S, y - 4 * S, 8 * S, 8 * S);
        ctx.fillStyle = "rgba(232,238,228,0.6)";
        ctx.fillText(String(p.track).padStart(3, "0"), x + 8 * S, y + 3.5 * S);
      }
    });
    ctx.letterSpacing = "0px";

    // 5) Telemetry HUD — framed corner data blocks.
    this._drawFieldHUD(ctx, S, W, H, pts.length);

    if (returnCanvas) return out;
    out.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "playsplat-interaction-field.png";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, "image/png");
    window.__toast?.(`Field exported — ${pts.length} interactions`);
  }

  // Corner data panels for the PNG export, set in a light sans with generous
  // tracking and two-column label/value rows — a quiet readout, not a HUD.
  _drawFieldHUD(ctx, S, W, H, plotted) {
    const st = this._sessionStats();
    const pad = 22 * S, lh = 16 * S, padIn = 11 * S, gap = 16 * S;
    const font = (px, w) => `${w || 400} ${px * S}px ${SANS}`;
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";

    // masthead — weighted name + light qualifier on one line
    ctx.letterSpacing = `${2.5 * S}px`;
    ctx.fillStyle = "rgba(245,246,242,0.9)"; ctx.font = font(15, 500);
    ctx.fillText("PLAYSPLAT", pad, pad + 13 * S);
    const tw = ctx.measureText("PLAYSPLAT ").width;
    ctx.font = font(15, 300); ctx.fillStyle = "rgba(245,246,242,0.5)";
    ctx.fillText("INTERACTION FIELD", pad + tw, pad + 13 * S);
    ctx.letterSpacing = `${1.5 * S}px`;
    ctx.fillStyle = "rgba(210,220,210,0.42)"; ctx.font = font(9.5, 400);
    ctx.fillText("OPERATIONAL IMAGE · COLLECTIVE TRACE", pad, pad + 29 * S);

    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    ctx.textAlign = "right";
    ctx.fillText(stamp, W - pad, pad + 13 * S);
    ctx.textAlign = "left";
    ctx.letterSpacing = "0px";
    if (!st.n) return;

    const panel = (anchorX, y, title, rows, right) => {
      ctx.letterSpacing = `${1.5 * S}px`; ctx.font = font(9.5, 500);
      let labelW = ctx.measureText(title).width;
      ctx.letterSpacing = `${0.5 * S}px`; ctx.font = font(10, 400);
      let valW = 0;
      for (const [l, v] of rows) {
        labelW = Math.max(labelW, ctx.measureText(l).width);
        valW = Math.max(valW, ctx.measureText(String(v)).width);
      }
      const w = padIn * 2 + labelW + gap + valW;
      const h = (rows.length + 1) * lh + padIn * 1.4;
      const x = right ? anchorX - w : anchorX;
      ctx.fillStyle = "rgba(8,12,12,0.34)"; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "rgba(220,228,218,0.2)"; ctx.lineWidth = 1 * S; ctx.strokeRect(x, y, w, h);
      ctx.letterSpacing = `${1.5 * S}px`; ctx.font = font(9.5, 500);
      ctx.fillStyle = "rgba(220,228,214,0.68)"; ctx.fillText(title, x + padIn, y + padIn + 9 * S);
      ctx.letterSpacing = `${0.5 * S}px`; ctx.font = font(10, 400);
      rows.forEach(([l, v], i) => {
        const ry = y + padIn + (i + 2) * lh;
        ctx.fillStyle = "rgba(225,232,222,0.48)"; ctx.fillText(l, x + padIn, ry);
        ctx.fillStyle = "rgba(245,248,242,0.8)"; ctx.fillText(String(v), x + padIn + labelW + gap, ry);
      });
      ctx.letterSpacing = "0px";
    };

    const f2 = (v) => v.toFixed(2);
    const metrics = [
      ["Interactions", st.n],
      ["Duration", this._fmtTime(st.dur)],
      ["Rate", `${st.ipm.toFixed(1)} / min`],
      ["Centroid", st.centroid.map(f2).join("  ")],
      ["Extent", st.extent.map(f2).join("  ")],
    ];
    const mh = (metrics.length + 1) * lh + padIn * 1.4;
    panel(pad, H - pad - mh, "FIELD METRICS", metrics, false);

    const fx = st.topEffects.map(([e, c]) => [e || "—", c]);
    if (fx.length) {
      const fh = (fx.length + 1) * lh + padIn * 1.4;
      panel(W - pad, H - pad - fh, "TOP EFFECTORS", fx, true);
    }
  }

  // Export an interactive, self-contained HTML page that REPLAYS the
  // interaction trajectory: a playhead sweeps the temporal order, growing the
  // glowing route and lighting nodes over a dimmed backdrop, with a scrubber
  // and a live telemetry readout. Portable (no external libraries; the scene
  // backdrop is baked in as a data-URI), so it travels as a keepsake.
  exportHeatmapHTML({ background = null } = {}) {
    const raw = this._collectTrajectory();
    if (!raw.length) { window.__toast?.("No interactions to export yet"); return; }
    const W = this._w, H = this._h;
    const pts = raw.map((p) => ({
      x: +(p.x / W).toFixed(5), y: +(p.y / H).toFixed(5),
      t: +(p.t).toFixed(3), track: p.track, fx: p.effect,
    }));
    const st = this._sessionStats();

    // bake a dimmed, downscaled backdrop so the export is self-contained
    let bg = null;
    if (background) {
      try {
        const s = Math.min(1, 1600 / W);
        const bc = document.createElement("canvas");
        bc.width = Math.round(W * s); bc.height = Math.round(H * s);
        const bx = bc.getContext("2d");
        bx.drawImage(background, 0, 0, bc.width, bc.height);
        bx.fillStyle = "rgba(5,8,12,0.55)"; bx.fillRect(0, 0, bc.width, bc.height);
        bg = bc.toDataURL("image/jpeg", 0.72);
      } catch (e) { bg = null; }
    }

    const data = {
      pts, bg, aspect: W / H, dur: st.dur || 0, t0: this.log[0]?.t || 0,
      stats: {
        n: st.n, ipm: +(st.ipm || 0).toFixed(1),
        centroid: (st.centroid || []).map((v) => +v.toFixed(2)),
        extent: (st.extent || []).map((v) => +v.toFixed(2)),
        topEffects: st.topEffects || [],
      },
    };
    const json = JSON.stringify(data).replace(/</g, "\\u003c");
    const blob = new Blob([trajectoryHTML(json)], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "playsplat-trajectory.html";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    window.__toast?.(`Trajectory HTML exported — ${pts.length} points`);
  }

  // Export the interaction session as a CSV for paper support: a summary
  // header (counts, duration, spatial centroid/extent, per-effect breakdown)
  // followed by the full per-interaction log with 3D world coordinates and
  // the representation state at each touch.
  exportCSV() {
    const rows = this.log;
    if (!rows.length) { window.__toast?.("No interactions to export yet"); return; }
    const n = rows.length;
    const dur = rows[n - 1].t - rows[0].t;

    // Per-effect tally.
    const byEffect = {};
    for (const r of rows) byEffect[r.effect || "(none)"] = (byEffect[r.effect || "(none)"] || 0) + 1;

    // Spatial centroid + axis extent over the world-space hit points.
    let cx = 0, cy = 0, cz = 0;
    let xmin = Infinity, ymin = Infinity, zmin = Infinity;
    let xmax = -Infinity, ymax = -Infinity, zmax = -Infinity;
    for (const r of rows) {
      cx += r.x; cy += r.y; cz += r.z;
      xmin = Math.min(xmin, r.x); xmax = Math.max(xmax, r.x);
      ymin = Math.min(ymin, r.y); ymax = Math.max(ymax, r.y);
      zmin = Math.min(zmin, r.z); zmax = Math.max(zmax, r.z);
    }
    cx /= n; cy /= n; cz /= n;
    const f = (v) => Number(v).toFixed(4);

    const lines = [];
    lines.push(`# PlaySplat interaction session`);
    lines.push(`# total_interactions,${n}`);
    lines.push(`# session_duration_s,${dur.toFixed(1)}`);
    lines.push(`# interactions_per_minute,${dur > 0 ? (n / (dur / 60)).toFixed(1) : "n/a"}`);
    lines.push(`# centroid_world_xyz,${f(cx)},${f(cy)},${f(cz)}`);
    lines.push(`# extent_world_xyz,${f(xmax - xmin)},${f(ymax - ymin)},${f(zmax - zmin)}`);
    lines.push(`# bbox_min_xyz,${f(xmin)},${f(ymin)},${f(zmin)}`);
    lines.push(`# bbox_max_xyz,${f(xmax)},${f(ymax)},${f(zmax)}`);
    lines.push(`#`);
    lines.push(`# per_effect_counts:`);
    for (const [e, c] of Object.entries(byEffect).sort((a, b) => b[1] - a[1])) {
      lines.push(`#   ${e},${c},${((c / n) * 100).toFixed(1)}%`);
    }
    lines.push(`#`);
    // Data table — one row per interaction.
    lines.push(`time_s,track,world_x,world_y,world_z,effect,splat,billboard,voxel,confidence`);
    for (const r of rows) {
      lines.push(`${r.t.toFixed(2)},${r.track},${f(r.x)},${f(r.y)},${f(r.z)},"${r.effect}",${r.splat},${r.quad},${r.voxel},${r.label}`);
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "playsplat-interactions.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    window.__toast?.(`Exported ${n} interactions to CSV`);
  }

  dispose() {
    window.removeEventListener("resize", this._onResize);
    this.canvas.remove();
  }
}

// ---------------------------------------------------------------------------
// Standalone HTML trajectory export. `trajectoryHTML` wraps the markup + CSS
// and embeds the dataset plus the viewer (via `_trajViewer.toString()`), so
// the produced file has no external dependencies. `_trajViewer` runs inside
// the exported page and reads its data from `window.__TRAJ__`.
// ---------------------------------------------------------------------------
function _trajViewer() {
  const D = window.__TRAJ__;
  const cv = document.getElementById("c"), ctx = cv.getContext("2d");
  const pp = document.getElementById("pp"), sc = document.getElementById("sc");
  const rd = document.getElementById("rd"), metrics = document.getElementById("metrics");
  const F = '"Helvetica Neue", "Inter", Arial, sans-serif';
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  let vw = 0, vh = 0, dpr = 1, stage = { x: 0, y: 0, w: 0, h: 0 };
  let bgImg = null;
  if (D.bg) { bgImg = new Image(); bgImg.src = D.bg; }

  const fmtT = (s) => { s = Math.max(0, s | 0); const m = (s / 60) | 0, ss = s % 60; return (m < 10 ? "0" : "") + m + ":" + (ss < 10 ? "0" : "") + ss; };

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = window.innerWidth; vh = window.innerHeight;
    cv.width = vw * dpr; cv.height = vh * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let w = vw, h = vw / D.aspect;
    if (h > vh) { h = vh; w = vh * D.aspect; }
    stage = { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
  }
  const SX = (nx) => stage.x + nx * stage.w, SY = (ny) => stage.y + ny * stage.h;

  function render(progress) {
    const N = D.pts.length, count = Math.max(1, Math.min(N, Math.floor(progress * N)));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    ctx.fillStyle = "#05070a"; ctx.fillRect(0, 0, vw, vh);
    if (bgImg && bgImg.complete && bgImg.naturalWidth) ctx.drawImage(bgImg, stage.x, stage.y, stage.w, stage.h);

    ctx.globalCompositeOperation = "lighter";
    // ghost of the full path — a faint neutral thread
    ctx.strokeStyle = "rgba(150,170,150,0.045)"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < N; i++) { const p = D.pts[i], x = SX(p.x), y = SY(p.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
    // soft sage-white blooms for recent points
    for (let i = Math.max(0, count - 60); i < count; i++) {
      const p = D.pts[i], x = SX(p.x), y = SY(p.y);
      const g = ctx.createRadialGradient(x, y, 0, x, y, 38);
      g.addColorStop(0, "rgba(208,222,210,0.10)"); g.addColorStop(1, "rgba(208,222,210,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 38, 0, 7); ctx.fill();
    }
    // delicate filament trajectory
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.shadowColor = "rgba(225,235,225,0.5)";
    for (let i = 1; i < count; i++) {
      const a = D.pts[i - 1], b = D.pts[i], rec = i / count;
      ctx.shadowBlur = 2;
      ctx.strokeStyle = "rgba(236,240,232," + (0.06 + rec * 0.2).toFixed(3) + ")";
      ctx.lineWidth = 0.5 + rec * 0.7;
      ctx.beginPath(); ctx.moveTo(SX(a.x), SY(a.y)); ctx.lineTo(SX(b.x), SY(b.y)); ctx.stroke();
    }
    ctx.shadowBlur = 0; ctx.globalCompositeOperation = "source-over";
    // nodes
    for (let i = 0; i < count; i++) { const p = D.pts[i]; ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.beginPath(); ctx.arc(SX(p.x), SY(p.y), 1.4, 0, 7); ctx.fill(); }
    // head reticle
    const head = D.pts[count - 1], hx = SX(head.x), hy = SY(head.y);
    ctx.strokeStyle = "rgba(232,238,228,0.85)"; ctx.lineWidth = 1;
    ctx.strokeRect(hx - 6, hy - 6, 12, 12);
    ctx.beginPath();
    ctx.moveTo(hx - 11, hy); ctx.lineTo(hx - 8, hy); ctx.moveTo(hx + 8, hy); ctx.lineTo(hx + 11, hy);
    ctx.moveTo(hx, hy - 11); ctx.lineTo(hx, hy - 8); ctx.moveTo(hx, hy + 8); ctx.lineTo(hx, hy + 11); ctx.stroke();
    ctx.letterSpacing = "1px"; ctx.font = "10px " + F; ctx.fillStyle = "rgba(232,238,228,0.85)";
    ctx.fillText(String(head.track).padStart(3, "0") + (head.fx ? ("  " + head.fx) : ""), hx + 10, hy + 3.5);
    ctx.letterSpacing = "0px";

    rd.textContent = "PT " + count + " / " + N + "   T+" + fmtT(head.t - D.t0);
  }

  function fillMetrics() {
    const s = D.stats; if (!s || !s.n) { metrics.innerHTML = ""; return; }
    const row = (l, v) => '<div class="m"><span>' + esc(l) + '</span><b>' + esc(v) + '</b></div>';
    const top = (s.topEffects || []).slice(0, 4).map((e) => row(e[0], e[1])).join("");
    metrics.innerHTML =
      row("Interactions", s.n) +
      row("Rate", s.ipm + " / min") +
      row("Centroid", (s.centroid || []).join("  ")) +
      row("Extent", (s.extent || []).join("  ")) +
      '<div class="mt">Top effectors</div>' + top;
  }

  let progress = 0, playing = true, last = 0;
  const SECS = Math.min(20, Math.max(8, D.dur || 10));
  function loop(ts) {
    if (!last) last = ts;
    const dt = (ts - last) / 1000; last = ts;
    if (playing) { progress += dt / SECS; if (progress >= 1) progress = 0; sc.value = Math.round(progress * 1000); }
    render(progress);
    requestAnimationFrame(loop);
  }
  pp.addEventListener("click", () => { playing = !playing; pp.textContent = playing ? "❚❚" : "▶"; });
  sc.addEventListener("input", () => { playing = false; pp.textContent = "▶"; progress = sc.value / 1000; render(progress); });
  window.addEventListener("resize", () => { layout(); render(progress); });
  layout(); fillMetrics();
  if (bgImg) bgImg.onload = () => render(progress);
  requestAnimationFrame(loop);
}

function trajectoryHTML(json) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>PlaySplat — Interaction Trajectory</title>
<style>
  html,body{margin:0;height:100%;background:#05070a;color:#e6ebe2;
    font:13px "Helvetica Neue","Inter",Arial,sans-serif;font-weight:300;overflow:hidden}
  #c{position:fixed;inset:0;width:100vw;height:100vh;display:block}
  .hud{position:fixed;pointer-events:none}
  .tl{top:24px;left:24px}
  .ttl{font-size:15px;font-weight:500;color:#f4f6f0;letter-spacing:.22em}
  .ttl span{font-weight:300;opacity:.55}
  .sub{margin-top:5px;font-size:9.5px;color:#aebfac;opacity:.6;text-transform:uppercase;letter-spacing:.2em}
  #metrics{margin:16px 0 0;min-width:224px;font-size:11px;letter-spacing:.04em}
  #metrics .m{display:flex;justify-content:space-between;gap:24px;line-height:1.85}
  #metrics .m span{color:#c4d0c0;opacity:.55}
  #metrics .m b{font-weight:500;color:#eef2ea}
  #metrics .mt{margin-top:10px;color:#aebfac;opacity:.6;text-transform:uppercase;letter-spacing:.16em;font-size:9.5px}
  .bar{position:fixed;left:24px;right:24px;bottom:20px;display:flex;align-items:center;gap:16px}
  #pp{background:transparent;color:#e6ebe2;border:1px solid rgba(220,228,214,.34);
    font:inherit;letter-spacing:.14em;padding:7px 15px;cursor:pointer}
  #pp:hover{background:#e6ebe2;color:#05070a}
  #sc{flex:1;accent-color:#cdd8c8;height:2px}
  #rd{min-width:210px;text-align:right;color:#cdd8c8;letter-spacing:.14em;font-size:11px}
</style></head>
<body>
  <canvas id="c"></canvas>
  <div class="hud tl">
    <div class="ttl">PLAYSPLAT&nbsp;&nbsp;<span>Interaction Trajectory</span></div>
    <div class="sub">operational image · collective trace</div>
    <div id="metrics"></div>
  </div>
  <div class="bar">
    <button id="pp">❚❚</button>
    <input id="sc" type="range" min="0" max="1000" value="0"/>
    <div id="rd">—</div>
  </div>
  <script>window.__TRAJ__=${json};(${_trajViewer.toString()})();</script>
</body></html>`;
}
