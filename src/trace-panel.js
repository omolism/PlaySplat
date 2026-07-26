// ---------------------------------------------------------------------------
// Trace Panel — the top-level surface for the interaction recorder.
//
// Product rationale: recording the visitor's touches, accumulating them into a
// collective trace, and exporting that trace is one of the system's headline
// capabilities, not a rendering parameter. It used to live as a collapsed
// lil-gui folder ("Blob Tracker") among the visual effects, which filed an
// instrument as an ornament and hid the exports three levels deep.
//
// Layout rationale: the panel's job is "show me what I made, then let me take
// it", so the artifact leads. A live top-down plot of the session sits at the
// top, because a panel about a spatial visualization should show the spatial
// visualization rather than describe it in words; it also makes the three
// export formats self-explanatory before a single label is read. Everything
// else is deliberately quiet: two stats at one size instead of one orphaned
// hero number, a single parameter, and the exports as equal-weight tiles since
// they are the payoff. No section headers: with this little content they cost
// more attention than they organise.
//
// Wiring: the panel owns no recorder state. Reads and writes go straight to
// the BlobTracker instance, and exports call the same functions the Studio
// panel's Export folder calls, so both surfaces stay in sync by construction.
// ---------------------------------------------------------------------------

export class TracePanel {
  /**
   * @param {object} opts
   * @param {*} opts.tracker            - the BlobTracker instance
   * @param {object} opts.exports       - { field(), trajectory(), data() }
   * @param {HTMLElement} [opts.mountEl]
   */
  constructor({ tracker, exports = {}, mountEl = document.body }) {
    this.tracker = tracker;
    this.exports = exports;
    this.open = false;
    this.onOpenChange = null;

    this.el = document.createElement("div");
    this.el.id = "trace-panel";
    // .ui-pop is the shared popover shell (see style.css).
    this.el.className = "ui-pop";
    this.el.innerHTML = `
      <div class="pop-head">
        <div class="pop-title">Interaction Trace</div>
        <!-- Recording runs from page load and has no off switch here, so this
             reads as a state label rather than a control. -->
        <span class="tp-rec" data-k="rec">Rec</span>
        <button class="pop-x" data-act="close" type="button" aria-label="Close">&times;</button>
      </div>

      <div class="pop-body">
        <!-- The artifact leads. Top-down plot of where the session happened,
             which is exactly what the Field and Trajectory exports contain. -->
        <div class="tp-plot">
          <canvas data-k="plot"></canvas>
          <div class="tp-plot-empty" data-k="empty">Click or pinch the scene to leave a trace</div>
          <!-- Top-down reads the spatial distribution; the 3D view reads the
               vertical structure, which a plan view flattens away entirely. -->
          <div class="tp-plot-modes" data-k="modes">
            <button class="tp-mode active" data-mode="top" type="button">Plan</button>
            <button class="tp-mode" data-mode="iso" type="button">3D</button>
          </div>
        </div>

        <div class="tp-stats">
          <div class="tp-stat">
            <span class="tp-stat-v" data-k="count">0</span>
            <span class="tp-stat-k">interactions</span>
          </div>
          <div class="tp-stat">
            <span class="tp-stat-v" data-k="dur">00:00</span>
            <span class="tp-stat-k">elapsed</span>
          </div>
          <button class="tp-clear" data-act="clear" type="button">Clear</button>
        </div>

        <!-- Persistence is the one parameter that changes what the piece
             means: ephemeral touches versus an enduring collective map. -->
        <div class="tp-persist">
          <div class="tp-persist-head">
            <span>Persistence</span>
            <span class="tp-persist-v" data-k="persistVal">0.85</span>
          </div>
          <input type="range" min="0" max="1" step="0.01" data-k="persist" />
          <div class="tp-scale"><span>ephemeral</span><span>enduring</span></div>
        </div>

        <div class="tp-take">
          <div class="tp-take-label">Take your participation with you</div>
          <div class="tp-tiles">
            <button class="tp-tile" data-act="field" type="button">
              <span class="tp-tile-fmt">PNG</span>
              <span class="tp-tile-name">Field</span>
            </button>
            <button class="tp-tile" data-act="trajectory" type="button">
              <span class="tp-tile-fmt">HTML</span>
              <span class="tp-tile-name">Trajectory</span>
            </button>
            <button class="tp-tile" data-act="data" type="button">
              <span class="tp-tile-fmt">CSV</span>
              <span class="tp-tile-name">Data</span>
            </button>
          </div>
        </div>
      </div>
    `;
    mountEl.appendChild(this.el);

    this.$ = {};
    this.el.querySelectorAll("[data-k]").forEach(n => { this.$[n.dataset.k] = n; });

    this.el.querySelector('[data-act="close"]').addEventListener("click", () => this.close());
    this.el.querySelector('[data-act="clear"]').addEventListener("click", () => {
      this.tracker.clearAll();
      this.sync();
    });
    this.$.persist.addEventListener("input", () => {
      this.tracker.params.persistence = parseFloat(this.$.persist.value);
      this.sync();
    });

    // Plot mode. Kept on the instance so it survives re-syncs, and the 3D view
    // slowly turns while open so depth reads from parallax rather than from
    // shading, which would be unreadable at this size.
    this.plotMode = "top";
    this._spin = 0;
    this.el.querySelectorAll(".tp-mode").forEach(b => {
      b.addEventListener("click", () => {
        this.plotMode = b.dataset.mode;
        this.el.querySelectorAll(".tp-mode").forEach(x => x.classList.toggle("active", x === b));
        this._drawPlot();
      });
    });

    const run = (fn) => { if (typeof fn === "function") fn(); };
    this.el.querySelector('[data-act="field"]')
      .addEventListener("click", () => run(this.exports.field));
    this.el.querySelector('[data-act="trajectory"]')
      .addEventListener("click", () => run(this.exports.trajectory));
    this.el.querySelector('[data-act="data"]')
      .addEventListener("click", () => run(this.exports.data));

    // Outside click dismisses. The Playbar's Trace button is skipped so its
    // toggle is not fought by an immediate re-close.
    this._onOutsidePointerDown = (e) => {
      if (!this.open) return;
      if (this.el.contains(e.target)) return;
      if (e.target?.closest?.('[data-act="trace"], .lil-gui')) return;
      this.close();
    };

    this.sync();
  }

  // Top-down plot of the session: the recorded points in world x/z, joined in
  // time order. Deliberately schematic rather than a faithful projection, so
  // it stays readable at thumbnail size and does not pretend to be the render.
  _drawPlot() {
    const cv = this.$.plot;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const w = rect.width || 300, h = rect.height || 96;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const rows = this.tracker.log || [];
    if (!rows.length) return;

    // Centre the cloud on its own bounds so both projections stay framed
    // whatever part of the scene the visitor worked in.
    const b = { x: [Infinity, -Infinity], y: [Infinity, -Infinity], z: [Infinity, -Infinity] };
    for (const r of rows) {
      b.x[0] = Math.min(b.x[0], r.x); b.x[1] = Math.max(b.x[1], r.x);
      b.y[0] = Math.min(b.y[0], r.y); b.y[1] = Math.max(b.y[1], r.y);
      b.z[0] = Math.min(b.z[0], r.z); b.z[1] = Math.max(b.z[1], r.z);
    }
    const mid = (k) => (b[k][0] + b[k][1]) / 2;
    const cx = mid("x"), cy = mid("y"), cz = mid("z");
    const extent = Math.max(b.x[1] - b.x[0], b.y[1] - b.y[0], b.z[1] - b.z[0], 1e-3);

    const iso = this.plotMode === "iso";
    let project;

    if (!iso) {
      // Plan: straight x/z, aspect preserved so the shape of the visit is not
      // distorted.
      const pad = 12;
      const spanX = Math.max(b.x[1] - b.x[0], 1e-3);
      const spanZ = Math.max(b.z[1] - b.z[0], 1e-3);
      const s = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanZ);
      project = (r) => [
        (r.x - cx) * s + w / 2,
        (r.z - cz) * s + h / 2,
        0,
      ];
    } else {
      // Isometric: yaw slowly, tilt fixed. Depth is returned as the third
      // component so points can be sorted and faded back to front.
      const s = (Math.min(w, h) - 26) / extent;
      const yaw = this._spin;
      const tilt = 0.52;
      const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
      const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
      project = (r) => {
        const px = r.x - cx, py = r.y - cy, pz = r.z - cz;
        const rx = px * cosY - pz * sinY;
        const rz = px * sinY + pz * cosY;
        return [
          rx * s + w / 2,
          (rz * sinT - py * cosT) * s + h / 2,
          rz,
        ];
      };
    }

    const n = rows.length;
    const pts = rows.map((r, i) => {
      const [x, y, d] = project(r);
      return { x, y, d, recency: n > 1 ? i / (n - 1) : 1, last: i === n - 1 };
    });

    if (iso) {
      // Ground plane: without a horizon the isometric cloud has no frame of
      // reference and reads as noise.
      const s = (Math.min(w, h) - 26) / extent;
      const half = extent / 2;
      const yaw = this._spin, tilt = 0.52;
      const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
      const sinT = Math.sin(tilt), cosT = Math.cos(tilt);
      const floorY = b.y[0] - cy;
      const corner = (sx, sz) => {
        const px = sx * half, pz = sz * half;
        const rx = px * cosY - pz * sinY;
        const rz = px * sinY + pz * cosY;
        return [rx * s + w / 2, (rz * sinT - floorY * cosT) * s + h / 2];
      };
      const c = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      ctx.beginPath();
      c.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Drop lines tie each point to that plane, which is what actually
      // conveys height in a still frame.
      pts.forEach((p, i) => {
        const r = rows[i];
        const px = r.x - cx, pz = r.z - cz;
        const rx = px * cosY - pz * sinY;
        const rzz = px * sinY + pz * cosY;
        const fx = rx * s + w / 2;
        const fy = (rzz * sinT - floorY * cosT) * s + h / 2;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(fx, fy);
        ctx.strokeStyle = `rgba(255, 255, 255, ${(0.05 + p.recency * 0.10).toFixed(3)})`;
        ctx.stroke();
      });
    }

    // Path in time order, faint: this is the Trajectory export in miniature.
    if (pts.length > 1) {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Back to front in the 3D view so nearer points occlude correctly.
    const order = iso ? [...pts].sort((a, c2) => a.d - c2.d) : pts;
    order.forEach((p) => {
      const a = 0.20 + p.recency * 0.70;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.last ? 3 : 2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
      ctx.fill();
    });
  }

  // Mirror recorder state into the panel. Cheap enough to call on a timer
  // while open; skipped entirely while closed.
  sync() {
    if (!this.el) return;
    const t = this.tracker;
    const n = t.log?.length || 0;
    const on = !!t.params.enable;

    // sessionLabel() carries the count and duration together; the panel shows
    // them as separate stats, so the duration is taken from its tail.
    const label = t.sessionLabel();
    const dur = label.includes("·") ? label.split("·").pop().trim() : "00:00";

    this.$.count.textContent = n;
    this.$.dur.textContent = n ? dur : "00:00";
    this.$.rec.textContent = on ? "Rec" : "Paused";
    this.$.rec.classList.toggle("off", !on);
    this.$.empty.style.display = n ? "none" : "";
    this.el.classList.toggle("has-data", n > 0);

    const p = t.params.persistence ?? 0;
    if (document.activeElement !== this.$.persist) this.$.persist.value = p;
    this.$.persistVal.textContent = Number(p).toFixed(2);

    // Exports are meaningless with an empty log; disable rather than let them
    // fail into a toast.
    this.el.querySelectorAll(".tp-tile").forEach(b => { b.disabled = n === 0; });
    this.el.querySelector(".tp-clear").disabled = n === 0;
    this.$.modes.style.display = n ? "" : "none";

    if (this.plotMode === "iso") this._spin += 0.06;
    this._drawPlot();
  }

  show() {
    this.open = true;
    this.el.classList.add("show");
    // Defer the first sync one frame so the canvas has a measured box.
    requestAnimationFrame(() => this.sync());
    this._timer = setInterval(() => this.sync(), 400);
    this.onOpenChange?.(true);
    setTimeout(() => {
      if (this.open) document.addEventListener("pointerdown", this._onOutsidePointerDown, true);
    }, 0);
  }

  close() {
    this.open = false;
    this.el.classList.remove("show");
    clearInterval(this._timer);
    this._timer = null;
    document.removeEventListener("pointerdown", this._onOutsidePointerDown, true);
    this.onOpenChange?.(false);
  }

  toggle()   { this.open ? this.close() : this.show(); }
  setOpen(v) { v ? this.show() : this.close(); }

  dispose() {
    clearInterval(this._timer);
    document.removeEventListener("pointerdown", this._onOutsidePointerDown, true);
    this.el.remove();
  }
}
