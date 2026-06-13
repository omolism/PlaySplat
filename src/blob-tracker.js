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

// Confidence labels match the reference exactly: multiples of 1/7, so they
// read as 0.1429 / 0.2857 / ... / 1.0000 / 1.1429 like a quantized detector
// score. id cycles 1..8.
const labelFor = (id) => (id / 7).toFixed(4);

export class BlobTracker {
  /**
   * @param {object} opts
   * @param {THREE.Camera} opts.camera
   * @param {HTMLElement}  [opts.mountEl]
   */
  constructor({ camera, mountEl = document.body }) {
    this.camera = camera;
    this.blobs  = [];       // { world, t, life, size, id, jx, jy }
    this._elapsed = 0;
    this._labelSeq = 0;

    this.params = {
      enable:       true,    // the requested click feedback — on by default
      boxSize:      120,     // base box edge in CSS px (jittered per blob)
      lifetime:     2.4,     // seconds of the bright "active" phase
      // Persistence reframes the tracker as a trace rather than a blip:
      //   0   = ephemeral — the box fades fully and is removed (a blip).
      //   1   = enduring  — after the bright phase it settles to a faint
      //         residual and STAYS, so every visitor's touch accumulates on
      //         the garden as a collective map of where people looked.
      //   0<p<1 = it lingers, but dimmer.
      // The bright spawn pulse is always present; persistence only governs
      // what remains afterward. In an exhibition, raise maxBlobs so the
      // accumulation has room to build.
      persistence:  0.0,
      maxBlobs:     12,      // FIFO cap (raise for exhibition accumulation)
      connections:  true,    // draw connector lines between trackers
      scanlines:    true,    // CRT scanline fill inside each box
      glow:         true,    // soft glow on box edges + connectors
      label:        true,    // confidence number tag
    };
    // Peak alpha of a fully-persistent residual trace — visible as history
    // without competing with freshly-spawned (bright) boxes.
    this._RESIDUAL = 0.20;

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
    // Structured interaction record for the CSV export (independent of the
    // display FIFO; capped with the heat history).
    this.log.push({
      t:      this._elapsed,
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
      id: this._labelSeq,
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
      const fade   = a > 0.6 ? 1 - (a - 0.6) / 0.4 : 1;
      const bright = Math.max(0, Math.min(1, grow * fade));
      // Persistent traces never drop below the residual level; ephemeral
      // ones (residual 0) fall to zero and get culled next frame.
      const alpha  = Math.max(bright, residual);
      pts.push({ x: p.x + b.jx, y: p.y + b.jy, s: b.size * (0.85 + 0.15 * grow), alpha, id: b.id });
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

    // Confidence label, baseline just inside the top-right corner.
    if (this.params.label) {
      ctx.font = "11px ui-monospace, 'SF Mono', Menlo, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.fillText(labelFor(p.id), x0 + sz - 5, y0 + 5);
    }
  }

  // Export the accumulated interaction history as a heatmap PNG, projected
  // through the CURRENT camera so the density sits over the garden the way
  // the audience saw it. The exported still deliberately steps outside the
  // monochrome UI rule — as a data keepsake of the show, a warm thermal
  // ramp (black to red to amber to white) reads density far better than
  // grayscale would.
  // @param {object} opts
  // @param {HTMLCanvasElement} [opts.background] - the WebGL canvas to dim
  //        behind the heat (must hold a freshly rendered frame).
  exportHeatmap({ background = null, returnCanvas = false } = {}) {
    const W = this._w, H = this._h;
    if (!this.heatPoints.length) { window.__toast?.("No interactions to map yet"); return; }

    // 1) Density accumulation buffer — additive white gaussian splats.
    const dens = document.createElement("canvas");
    dens.width = W; dens.height = H;
    const dc = dens.getContext("2d");
    dc.fillStyle = "#000"; dc.fillRect(0, 0, W, H);
    dc.globalCompositeOperation = "lighter";
    const R = Math.max(40, Math.round(Math.min(W, H) * 0.06));   // splat radius
    let plotted = 0;
    for (const wp of this.heatPoints) {
      const p = this._project(wp);
      if (!p) continue;
      plotted++;
      const g = dc.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
      g.addColorStop(0, "rgba(255,255,255,0.30)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      dc.fillStyle = g;
      dc.beginPath(); dc.arc(p.x, p.y, R, 0, Math.PI * 2); dc.fill();
    }

    // 2) Output canvas — dimmed scene behind, thermal-mapped density over.
    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const oc = out.getContext("2d");
    oc.fillStyle = "#000"; oc.fillRect(0, 0, W, H);
    if (background) {
      try { oc.drawImage(background, 0, 0, W, H); } catch (e) { /* tainted/empty */ }
      oc.fillStyle = "rgba(0,0,0,0.55)"; oc.fillRect(0, 0, W, H);   // dim for contrast
    }

    const dImg = dc.getImageData(0, 0, W, H).data;
    const oImg = oc.getImageData(0, 0, W, H);
    const o = oImg.data;
    // Normalize against the peak density so the ramp uses its full range.
    let peak = 1;
    for (let i = 0; i < dImg.length; i += 4) if (dImg[i] > peak) peak = dImg[i];
    for (let i = 0; i < dImg.length; i += 4) {
      const t = Math.min(dImg[i] / peak, 1);          // 0..1 density
      if (t < 0.02) continue;                          // leave cold areas as scene
      // thermal ramp: black→red→amber→white
      const r = Math.min(t * 3.0, 1);
      const g = Math.min(Math.max(t * 3.0 - 1, 0), 1);
      const b = Math.min(Math.max(t * 3.0 - 2, 0), 1);
      const a = Math.min(t * 1.6, 0.92);               // heat opacity over scene
      o[i]   = o[i]   * (1 - a) + r * 255 * a;
      o[i+1] = o[i+1] * (1 - a) + g * 255 * a;
      o[i+2] = o[i+2] * (1 - a) + b * 255 * a;
    }
    oc.putImageData(oImg, 0, 0);

    // 3) Caption strip — interaction count + timestamp, exhibition record.
    oc.font = "13px ui-monospace, 'SF Mono', Menlo, monospace";
    oc.fillStyle = "rgba(255,255,255,0.85)";
    oc.textBaseline = "bottom";
    oc.fillText(`PlaySplat  ·  ${plotted} interactions mapped`, 16, H - 14);

    // Caller wants the canvas itself (preview / test) rather than a download.
    if (returnCanvas) return out;

    // 4) Download.
    out.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "playsplat-heatmap.png";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, "image/png");
    window.__toast?.(`Heatmap exported — ${plotted} interactions`);
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
    lines.push(`time_s,world_x,world_y,world_z,effect,splat,billboard,voxel,confidence`);
    for (const r of rows) {
      lines.push(`${r.t.toFixed(2)},${f(r.x)},${f(r.y)},${f(r.z)},"${r.effect}",${r.splat},${r.quad},${r.voxel},${r.label}`);
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
