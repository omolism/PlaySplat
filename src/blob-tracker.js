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

  // Export the interaction history as a composed "interaction field" PNG —
  // a studio data-graphic laid as an OVERLAY over the bright scene (no dark
  // wash, only a soft vignette). It draws the temporal trajectory, nodes,
  // leader-line annotations into the margins, session metrics + effect
  // distribution, and a full-width effect-signal timeline, all in light sans
  // with a soft halo for legibility over the lit garden.
  // @param {object} opts
  // @param {HTMLCanvasElement} [opts.background] - the freshly rendered scene canvas.
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
    const FONT = (px, w) => `${w || 400} ${px * S}px ${SANS}`;
    const halo = (a, blur) => { ctx.shadowColor = `rgba(0,0,0,${a})`; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; ctx.shadowBlur = blur * S; };
    const noHalo = () => { ctx.shadowBlur = 0; };
    const f2 = (v) => v.toFixed(2);
    const pad = 30 * S;

    // session-level data the overlay panels draw from
    const st = this._sessionStats();
    const ec = {};
    for (const p of pts) ec[p.effect || "(none)"] = (ec[p.effect || "(none)"] || 0) + 1;
    const topEffects = Object.entries(ec).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const t0 = pts[0].t, span = Math.max(1e-3, pts[pts.length - 1].t - t0);

    // 1) Backdrop — keep the scene bright; only a soft vignette for cohesion
    //    and edge legibility, never a flat dark wash, so the graphics read as
    //    an overlay laid over the garden rather than a dimmed picture.
    ctx.fillStyle = "#0a0d10"; ctx.fillRect(0, 0, W, H);
    if (background) { try { ctx.drawImage(background, 0, 0, W, H); } catch (e) { /* tainted/empty */ } }
    const vg = ctx.createRadialGradient(W * 0.5, H * 0.46, Math.min(W, H) * 0.18, W * 0.5, H * 0.5, Math.max(W, H) * 0.66);
    vg.addColorStop(0, "rgba(6,9,11,0)"); vg.addColorStop(1, "rgba(6,9,11,0.4)");
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

    // 2) Trajectory — bright near-white filaments with a soft dark halo, so
    //    the route reads cleanly over the lit scene without dimming it.
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    halo(0.5, 2.5);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], rec = i / pts.length;
      ctx.strokeStyle = `rgba(244,246,240,${(0.26 + rec * 0.5).toFixed(3)})`;
      ctx.lineWidth = (0.6 + rec * 0.9) * S;
      ctx.beginPath(); ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b)); ctx.stroke();
    }
    noHalo();

    // 3) Nodes — small white points with a halo for contrast on any tone.
    halo(0.5, 2);
    for (const p of pts) { ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.beginPath(); ctx.arc(X(p), Y(p), 1.5 * S, 0, 7); ctx.fill(); }
    noHalo();

    // 4) Leader-line annotations — sampled detections labelled out into the
    //    calm right margin, the way a studio data-graphic annotates a subject.
    const annN = Math.min(6, pts.length);
    const labelX = W - pad, elbowX = W - pad - 150 * S;
    const bandTop = H * 0.17, bandBot = H * 0.66;
    for (let i = 0; i < annN; i++) {
      const p = pts[Math.floor((i + 0.5) / annN * pts.length)];
      const nx = X(p), ny = Y(p);
      const ly = bandTop + (annN > 1 ? i / (annN - 1) : 0) * (bandBot - bandTop);
      halo(0.45, 2);
      ctx.strokeStyle = "rgba(245,248,242,0.55)"; ctx.lineWidth = 1 * S;
      ctx.beginPath(); ctx.moveTo(nx, ny); ctx.lineTo(elbowX, ly); ctx.lineTo(labelX, ly); ctx.stroke();
      ctx.beginPath(); ctx.arc(nx, ny, 3 * S, 0, 7); ctx.stroke();
      noHalo();
      ctx.textAlign = "right"; halo(0.6, 3);
      ctx.letterSpacing = `${1 * S}px`;
      ctx.fillStyle = "rgba(246,248,242,0.95)"; ctx.font = FONT(11, 500);
      ctx.fillText(`#${String(p.track).padStart(3, "0")}  ${(p.effect || "").toUpperCase()}`.trim(), labelX, ly - 4 * S);
      ctx.letterSpacing = `${0.5 * S}px`;
      ctx.fillStyle = "rgba(214,224,212,0.72)"; ctx.font = FONT(9, 400);
      ctx.fillText(`T+${this._fmtTime(p.t - t0)}`, labelX, ly + 10 * S);
      noHalo(); ctx.letterSpacing = "0px"; ctx.textAlign = "left";
    }

    // 5) Masthead + session metrics + effect distribution (left), all set in
    //    light sans over a halo — no panels, no fills, pure overlay.
    halo(0.6, 3);
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    ctx.letterSpacing = `${2.5 * S}px`;
    ctx.fillStyle = "rgba(246,247,243,0.95)"; ctx.font = FONT(16, 500);
    ctx.fillText("PLAYSPLAT", pad, pad + 14 * S);
    const tw = ctx.measureText("PLAYSPLAT ").width;
    ctx.font = FONT(16, 300); ctx.fillStyle = "rgba(246,247,243,0.6)";
    ctx.fillText("INTERACTION FIELD", pad + tw, pad + 14 * S);
    ctx.letterSpacing = `${1.5 * S}px`;
    ctx.fillStyle = "rgba(214,224,212,0.6)"; ctx.font = FONT(9.5, 400);
    ctx.fillText("OPERATIONAL IMAGE · COLLECTIVE TRACE", pad, pad + 31 * S);
    ctx.textAlign = "right";
    ctx.fillText(new Date().toISOString().replace("T", " ").slice(0, 19), W - pad, pad + 14 * S);
    ctx.textAlign = "left"; noHalo();

    if (st.n) {
      let my = pad + 70 * S; const lh = 17 * S, valX = pad + 96 * S;
      halo(0.55, 3);
      ctx.letterSpacing = `${1.6 * S}px`; ctx.font = FONT(9, 500); ctx.fillStyle = "rgba(200,214,198,0.72)";
      ctx.fillText("SESSION", pad, my); my += 17 * S;
      ctx.letterSpacing = `${0.4 * S}px`;
      const rows = [
        ["Interactions", st.n], ["Duration", this._fmtTime(st.dur)],
        ["Rate", `${st.ipm.toFixed(1)} / min`],
        ["Centroid", st.centroid.map(f2).join("  ")], ["Extent", st.extent.map(f2).join("  ")],
      ];
      rows.forEach(([l, v]) => {
        ctx.font = FONT(10, 400); ctx.fillStyle = "rgba(224,232,220,0.62)"; ctx.fillText(l, pad, my);
        ctx.fillStyle = "rgba(246,248,242,0.92)"; ctx.fillText(String(v), valX, my); my += lh;
      });
      my += 14 * S;
      ctx.letterSpacing = `${1.6 * S}px`; ctx.font = FONT(9, 500); ctx.fillStyle = "rgba(200,214,198,0.72)";
      ctx.fillText("EFFECT DISTRIBUTION", pad, my); my += 18 * S;
      ctx.letterSpacing = `${0.4 * S}px`;
      const maxC = Math.max(1, ...topEffects.map((e) => e[1])), barW = 168 * S;
      topEffects.forEach(([name, c]) => {
        ctx.font = FONT(10, 400); ctx.fillStyle = "rgba(236,242,230,0.9)"; ctx.fillText(name, pad, my);
        ctx.textAlign = "right"; ctx.fillStyle = "rgba(246,248,242,0.8)"; ctx.fillText(String(c), pad + barW, my); ctx.textAlign = "left";
        ctx.fillStyle = "rgba(236,240,232,0.45)"; ctx.fillRect(pad, my + 4 * S, (c / maxC) * barW, 1.5 * S);
        my += 19 * S;
      });
      noHalo(); ctx.letterSpacing = "0px";
    }

    // 6) Effect signal timeline (bottom, full width) — each effect a lane,
    //    each interaction a tick at its true time across the session.
    if (topEffects.length) {
      const tlH = 118 * S, tlTop = H - pad - tlH, gutter = 100 * S;
      const plotX = pad + gutter, plotW = W - pad * 2 - gutter;
      halo(0.5, 3);
      ctx.letterSpacing = `${1.6 * S}px`; ctx.font = FONT(9, 500); ctx.fillStyle = "rgba(200,214,198,0.72)";
      ctx.fillText("EFFECT SIGNAL / OVER SESSION", pad, tlTop - 18 * S);
      noHalo(); ctx.letterSpacing = "0px";
      halo(0.35, 1.5); ctx.strokeStyle = "rgba(230,236,224,0.12)"; ctx.lineWidth = 1 * S;
      for (let i = 0; i <= 10; i++) { const gx = plotX + i / 10 * plotW; ctx.beginPath(); ctx.moveTo(gx, tlTop); ctx.lineTo(gx, tlTop + tlH); ctx.stroke(); }
      noHalo();
      const lh2 = tlH / topEffects.length;
      topEffects.forEach(([name], li) => {
        const y = tlTop + li * lh2 + lh2 / 2;
        halo(0.4, 1.5); ctx.strokeStyle = "rgba(230,236,224,0.18)"; ctx.lineWidth = 1 * S;
        ctx.beginPath(); ctx.moveTo(plotX, y); ctx.lineTo(plotX + plotW, y); ctx.stroke();
        ctx.font = FONT(9.5, 400); ctx.fillStyle = "rgba(232,238,228,0.78)"; ctx.textAlign = "left";
        ctx.fillText(name, pad, y + 3 * S); noHalo();
        halo(0.5, 2); ctx.strokeStyle = "rgba(246,248,242,0.85)"; ctx.lineWidth = 1.5 * S;
        for (const p of pts) {
          if ((p.effect || "") !== name) continue;
          const mx = plotX + ((p.t - t0) / span) * plotW;
          ctx.beginPath(); ctx.moveTo(mx, y - lh2 * 0.26); ctx.lineTo(mx, y + lh2 * 0.26); ctx.stroke();
        }
        noHalo();
      });
    }

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

  // Export an interactive, self-contained HTML page that REPLAYS the
  // interaction trajectory: a playhead sweeps the temporal order, growing the
  // glowing route and lighting nodes over a dimmed backdrop, with a scrubber
  // and a live telemetry readout. Portable (no external libraries; the scene
  // backdrop is baked in as a data-URI), so it travels as a keepsake.
  exportHeatmapHTML({ background = null } = {}) {
    if (!this.log.length) { window.__toast?.("No interactions to export yet"); return; }
    const W = this._w, H = this._h;
    const st = this._sessionStats();

    // Project every logged interaction and carry the full record (screen +
    // world coords, track id, effect, representation flags) so the dashboard
    // can derive its satellite panels from the same data.
    const pts = [];
    let xmin = Infinity, xmax = -Infinity, zmin = Infinity, zmax = -Infinity;
    for (const r of this.log) {
      const p = this._project(this._tmp.set(r.x, r.y, r.z));
      if (!p) continue;
      pts.push({
        x: +(p.x / W).toFixed(5), y: +(p.y / H).toFixed(5),
        t: +(r.t).toFixed(3), track: r.track, fx: r.effect || "",
        rep: (r.splat ? 1 : 0) | (r.quad ? 2 : 0) | (r.voxel ? 4 : 0),
        wx: +r.x.toFixed(3), wz: +r.z.toFixed(3),
      });
      xmin = Math.min(xmin, r.x); xmax = Math.max(xmax, r.x);
      zmin = Math.min(zmin, r.z); zmax = Math.max(zmax, r.z);
    }
    if (!pts.length) { window.__toast?.("Interactions are off-screen from this view"); return; }

    // Full per-effect tally (the timeline + distribution panels use all of it).
    const ec = {};
    for (const r of this.log) ec[r.effect || "(none)"] = (ec[r.effect || "(none)"] || 0) + 1;
    const effects = Object.entries(ec).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

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
      effects,
      world: { xmin: +xmin.toFixed(3), xmax: +xmax.toFixed(3), zmin: +zmin.toFixed(3), zmax: +zmax.toFixed(3) },
      stats: {
        n: st.n, ipm: +(st.ipm || 0).toFixed(1),
        centroid: (st.centroid || []).map((v) => +v.toFixed(2)),
        extent: (st.extent || []).map((v) => +v.toFixed(2)),
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
  const F = '"Helvetica Neue", "Inter", Arial, sans-serif';
  const $ = (id) => document.getElementById(id);
  const N = D.pts.length;
  const dur = D.dur || 1;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pad3 = (n) => String(n).padStart(3, "0");
  const fmtT = (s) => { s = Math.max(0, s | 0); const m = (s / 60) | 0, ss = s % 60; return (m < 10 ? "0" : "") + m + ":" + (ss < 10 ? "0" : "") + ss; };

  const cv = $("c"), ctx = cv.getContext("2d");
  const pp = $("pp"), scrub = $("scrub");
  let vw = 0, vh = 0, dpr = 1;
  let bgImg = null;
  if (D.bg) { bgImg = new Image(); bgImg.src = D.bg; bgImg.onload = () => render(progress); }

  const topEffects = D.effects.slice(0, 6);
  const headIndex = (p) => clamp(Math.floor(p * N), 1, N) - 1;
  const pad = 26, TLH = 96, GUT = 116, TLBOT = 52;   // timeline + scrub geometry

  function halo(a, b) { ctx.shadowColor = "rgba(0,0,0," + a + ")"; ctx.shadowBlur = b; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; }
  function noHalo() { ctx.shadowBlur = 0; }

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = window.innerWidth; vh = window.innerHeight;
    cv.width = vw * dpr; cv.height = vh * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  // cover the viewport with the source aspect — no letterbox, so no black bars
  function cover() {
    let w = vw, h = vw / D.aspect;
    if (h < vh) { h = vh; w = vh * D.aspect; }
    return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
  }

  function render(p) {
    if (!vw) return;
    const st = cover();
    const SX = (nx) => st.x + nx * st.w, SY = (ny) => st.y + ny * st.h;
    const count = clamp(Math.floor(p * N), 1, N);
    const head = D.pts[headIndex(p)];
    const curFx = head ? head.fx : "";

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    // 1) full-bleed bright backdrop (no dark wash over the image)
    if (bgImg && bgImg.complete && bgImg.naturalWidth) ctx.drawImage(bgImg, st.x, st.y, st.w, st.h);
    else { ctx.fillStyle = "#0a0d10"; ctx.fillRect(0, 0, vw, vh); }
    // 2) feathered top/bottom scrims (gradients, never hard boxes) to seat text
    let g = ctx.createLinearGradient(0, 0, 0, 175); g.addColorStop(0, "rgba(6,8,10,0.42)"); g.addColorStop(1, "rgba(6,8,10,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, vw, 175);
    g = ctx.createLinearGradient(0, vh - 210, 0, vh); g.addColorStop(0, "rgba(6,8,10,0)"); g.addColorStop(1, "rgba(6,8,10,0.5)");
    ctx.fillStyle = g; ctx.fillRect(0, vh - 210, vw, 210);

    // 3) trajectory + nodes + head reticle with leader annotation
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    halo(0.5, 2.5);
    for (let i = 1; i < count; i++) {
      const a = D.pts[i - 1], b = D.pts[i], rec = i / count;
      ctx.strokeStyle = "rgba(244,246,240," + (0.26 + rec * 0.5).toFixed(3) + ")";
      ctx.lineWidth = 0.7 + rec * 1.0;
      ctx.beginPath(); ctx.moveTo(SX(a.x), SY(a.y)); ctx.lineTo(SX(b.x), SY(b.y)); ctx.stroke();
    }
    noHalo();
    halo(0.5, 2);
    for (let i = 0; i < count; i++) { const q = D.pts[i]; ctx.fillStyle = "rgba(255,255,255,0.82)"; ctx.beginPath(); ctx.arc(SX(q.x), SY(q.y), 1.6, 0, 7); ctx.fill(); }
    noHalo();
    if (head) {
      const hx = SX(head.x), hy = SY(head.y);
      halo(0.5, 2.5); ctx.strokeStyle = "rgba(232,238,228,0.9)"; ctx.lineWidth = 1;
      ctx.strokeRect(hx - 6, hy - 6, 12, 12);
      const ly = clamp(hy, vh * 0.24, vh * 0.62), ex = vw - pad - 150;
      ctx.strokeStyle = "rgba(245,248,242,0.6)";
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(ex, ly); ctx.lineTo(vw - pad, ly); ctx.stroke();
      ctx.beginPath(); ctx.arc(hx, hy, 3.5, 0, 7); ctx.stroke(); noHalo();
      ctx.textAlign = "right"; halo(0.6, 3);
      ctx.letterSpacing = "1px"; ctx.fillStyle = "rgba(246,248,242,0.95)"; ctx.font = "500 12px " + F;
      ctx.fillText(("#" + pad3(head.track) + "  " + (head.fx || "").toUpperCase()).trim(), vw - pad, ly - 4);
      ctx.letterSpacing = "0.5px"; ctx.fillStyle = "rgba(214,224,212,0.72)"; ctx.font = "400 9px " + F;
      ctx.fillText("T+" + fmtT(head.t - D.t0), vw - pad, ly + 11);
      noHalo(); ctx.letterSpacing = "0px"; ctx.textAlign = "left";
    }

    // 4) masthead + live PT readout (top), session metrics (top-left)
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    halo(0.6, 4);
    ctx.letterSpacing = "2.5px"; ctx.fillStyle = "rgba(246,247,243,0.95)"; ctx.font = "500 15px " + F;
    ctx.fillText("PLAYSPLAT", pad, pad + 12);
    const tw = ctx.measureText("PLAYSPLAT ").width;
    ctx.font = "300 15px " + F; ctx.fillStyle = "rgba(246,247,243,0.6)"; ctx.fillText("INTERACTION FIELD", pad + tw, pad + 12);
    ctx.letterSpacing = "1.5px"; ctx.fillStyle = "rgba(214,224,212,0.6)"; ctx.font = "400 9px " + F;
    ctx.fillText("OPERATIONAL IMAGE · COLLECTIVE TRACE", pad, pad + 28);
    ctx.textAlign = "right";
    ctx.fillText("PT " + pad3(count) + " / " + pad3(N) + "   T+" + fmtT((head ? head.t : D.t0) - D.t0), vw - pad, pad + 12);
    ctx.textAlign = "left"; noHalo(); ctx.letterSpacing = "0px";

    const s = D.stats;
    let my = pad + 56; const valX = pad + 96;
    halo(0.55, 3);
    ctx.letterSpacing = "1.6px"; ctx.font = "500 9px " + F; ctx.fillStyle = "rgba(200,214,198,0.72)";
    ctx.fillText("SESSION", pad, my); my += 16;
    ctx.letterSpacing = "0.3px";
    [["Interactions", s.n], ["Rate", s.ipm + " / min"], ["Centroid", (s.centroid || []).join("  ")], ["Extent", (s.extent || []).join("  ")]].forEach(([l, v]) => {
      ctx.font = "400 10px " + F; ctx.fillStyle = "rgba(224,232,220,0.62)"; ctx.fillText(l, pad, my);
      ctx.fillStyle = "rgba(246,248,242,0.92)"; ctx.fillText(String(v), valX, my); my += 16;
    });
    noHalo();

    // 5) effect distribution (left, under metrics) — current effect highlighted
    my += 14;
    halo(0.55, 3);
    ctx.letterSpacing = "1.6px"; ctx.font = "500 9px " + F; ctx.fillStyle = "rgba(200,214,198,0.72)";
    ctx.fillText("EFFECT DISTRIBUTION", pad, my); my += 16;
    ctx.letterSpacing = "0.3px";
    const maxC = Math.max(1, Math.max.apply(null, topEffects.map((e) => e.count))), barW = 168;
    topEffects.forEach((e) => {
      const on = e.name === curFx;
      ctx.font = "400 10px " + F; ctx.fillStyle = on ? "rgba(246,248,242,0.98)" : "rgba(232,238,226,0.82)"; ctx.fillText(e.name, pad, my);
      ctx.textAlign = "right"; ctx.fillStyle = "rgba(246,248,242,0.82)"; ctx.fillText(String(e.count), pad + barW, my); ctx.textAlign = "left";
      ctx.fillStyle = on ? "rgba(246,248,242,0.85)" : "rgba(236,240,232,0.4)"; ctx.fillRect(pad, my + 4, (e.count / maxC) * barW, 1.5);
      my += 18;
    });
    noHalo(); ctx.letterSpacing = "0px";

    // 6) effect-signal timeline (bottom) — lanes, real interaction ticks, playhead
    if (topEffects.length) {
      const tlTop = vh - TLBOT - TLH, plotX = pad + GUT, plotW = vw - pad * 2 - GUT;
      halo(0.5, 3); ctx.letterSpacing = "1.6px"; ctx.font = "500 9px " + F; ctx.fillStyle = "rgba(200,214,198,0.72)";
      ctx.fillText("EFFECT SIGNAL / OVER SESSION", pad, tlTop - 12); noHalo(); ctx.letterSpacing = "0px";
      halo(0.35, 1.5); ctx.strokeStyle = "rgba(230,236,224,0.12)"; ctx.lineWidth = 1;
      for (let i = 0; i <= 10; i++) { const gx = plotX + i / 10 * plotW; ctx.beginPath(); ctx.moveTo(gx, tlTop); ctx.lineTo(gx, tlTop + TLH); ctx.stroke(); }
      noHalo();
      const lh2 = TLH / topEffects.length;
      topEffects.forEach((e, li) => {
        const y = tlTop + li * lh2 + lh2 / 2;
        halo(0.4, 1.5); ctx.strokeStyle = "rgba(230,236,224,0.16)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(plotX, y); ctx.lineTo(plotX + plotW, y); ctx.stroke();
        ctx.font = "400 9.5px " + F; ctx.fillStyle = "rgba(232,238,228,0.78)"; ctx.fillText(e.name, pad, y + 3); noHalo();
        for (const q of D.pts) {
          if ((q.fx || "") !== e.name) continue;
          const tn = (q.t - D.t0) / dur, mx = plotX + tn * plotW, on = tn <= p;
          halo(on ? 0.5 : 0.3, on ? 2 : 1.2); ctx.strokeStyle = on ? "rgba(246,248,242,0.9)" : "rgba(236,240,232,0.3)"; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(mx, y - lh2 * 0.26); ctx.lineTo(mx, y + lh2 * 0.26); ctx.stroke(); noHalo();
        }
      });
      halo(0.5, 3); ctx.strokeStyle = "rgba(246,248,242,0.75)"; ctx.lineWidth = 1;
      const phx = plotX + p * plotW; ctx.beginPath(); ctx.moveTo(phx, tlTop - 4); ctx.lineTo(phx, tlTop + TLH + 4); ctx.stroke(); noHalo();
    }
  }

  let progress = 0, playing = true, last = 0;
  const SECS = clamp(dur, 8, 22);
  function loop(ts) { if (!last) last = ts; const dt = (ts - last) / 1000; last = ts; if (playing) { progress += dt / SECS; if (progress >= 1) progress = 0; } render(progress); requestAnimationFrame(loop); }

  if (pp) pp.addEventListener("click", () => { playing = !playing; pp.textContent = playing ? "❚❚" : "▶"; });
  if (scrub) {
    let drag = false;
    const pAt = (cx) => clamp((cx - (pad + GUT)) / Math.max(1, vw - pad * 2 - GUT), 0, 1);
    scrub.addEventListener("pointerdown", (e) => { drag = true; scrub.setPointerCapture(e.pointerId); playing = false; if (pp) pp.textContent = "▶"; progress = pAt(e.clientX); });
    scrub.addEventListener("pointermove", (e) => { if (drag) progress = pAt(e.clientX); });
    scrub.addEventListener("pointerup", () => { drag = false; });
    scrub.addEventListener("pointercancel", () => { drag = false; });
  }
  window.addEventListener("resize", () => { layout(); render(progress); });
  layout(); requestAnimationFrame(loop);
}

function trajectoryHTML(json) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>PlaySplat — Interaction Field</title>
<style>
  html,body{margin:0;height:100%;background:#05070a;overflow:hidden;
    font:12px "Helvetica Neue","Inter",Arial,sans-serif;font-variant-numeric:tabular-nums}
  #c{position:fixed;inset:0;width:100vw;height:100vh;display:block}
  #scrub{position:fixed;left:0;right:0;bottom:0;height:190px;z-index:2;cursor:ew-resize}
  .ctl{position:fixed;left:24px;bottom:16px;z-index:3;display:flex;align-items:center;gap:14px}
  #pp{background:rgba(8,11,13,0.35);color:#e6ebe2;border:1px solid rgba(220,228,214,.4);
    font:inherit;letter-spacing:.14em;padding:7px 15px;cursor:pointer;-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}
  #pp:hover{background:#e6ebe2;color:#05070a}
</style></head>
<body>
  <canvas id="c"></canvas>
  <div id="scrub"></div>
  <div class="ctl"><button id="pp">❚❚</button></div>
  <script>window.__TRAJ__=${json};(${_trajViewer.toString()})();</script>
</body></html>`;
}
