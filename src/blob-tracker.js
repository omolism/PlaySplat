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
      lifetime:     2.4,     // seconds from spawn to full fade-out
      maxBlobs:     12,      // FIFO cap
      connections:  true,    // draw connector lines between trackers
      scanlines:    true,    // CRT scanline fill inside each box
      glow:         true,    // soft glow on box edges + connectors
      label:        true,    // confidence number tag
    };

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

  // Click → drop a tracker at the world-space hit point.
  addBlob(worldPos) {
    if (!this.params.enable || !worldPos) return;
    this._labelSeq = (this._labelSeq % 8) + 1;   // 1..8 → 1/7 .. 8/7
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

    // Advance + cull expired.
    for (const b of this.blobs) b.t += dt;
    this.blobs = this.blobs.filter(b => b.t < life);

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
      // spawn pop (fast ease-in) then linear-ish fade-out tail
      const grow  = Math.min(a / 0.12, 1);
      const fade  = a > 0.6 ? 1 - (a - 0.6) / 0.4 : 1;
      const alpha = Math.max(0, Math.min(1, grow * fade));
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

  dispose() {
    window.removeEventListener("resize", this._onResize);
    this.canvas.remove();
  }
}
