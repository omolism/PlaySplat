// ---------------------------------------------------------------------------
// Trace Panel — the top-level surface for the interaction recorder.
//
// Product rationale: recording the visitor's touches, accumulating them into a
// collective trace, and exporting that trace is one of the system's headline
// capabilities, not a rendering parameter. It used to live as a collapsed
// lil-gui folder ("Blob Tracker") among the visual effects, which filed an
// instrument as an ornament and hid the exports three levels deep.
//
// This panel promotes it to the same tier as the Playbar's other actions: one
// click from the bar, a focused popup that answers "what am I recording, and
// what can I take away". The lil-gui folder stays as the expert surface for
// the styling knobs; nothing here owns state that the folder does not.
//
// Wiring: the panel does NOT own recorder state. Reads and writes go straight
// to the BlobTracker instance, and exports call the same functions the Studio
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
    // .ui-pop is the shared popover shell (see style.css): same type scale,
    // row grammar and widget treatment as the Studio panel.
    this.el.className = "ui-pop";
    this.el.innerHTML = `
      <div class="pop-head">
        <div class="pop-title">Interaction Trace</div>
        <!-- Recording runs from page load and has no off switch in this
             surface, so this reads as a state label rather than a control. -->
        <span class="tp-rec" data-k="rec">Rec</span>
        <button class="pop-x" data-act="close" type="button" aria-label="Close">&times;</button>
      </div>

      <div class="pop-body">
        <!-- Session leads: a recorder's most useful status is its fill level,
             not its parameters. -->
        <div class="pop-sec">
          <div class="pop-sec-title">Session</div>
          <div class="tp-session">
            <div class="tp-count" data-k="count">0</div>
            <div class="tp-meta">
              <span class="tp-label" data-k="label">nothing recorded yet</span>
              <span class="tp-sub" data-k="hint">Click or pinch the scene to leave a trace</span>
            </div>
          </div>
        </div>

        <div class="pop-sec">
          <div class="pop-sec-title">Recording</div>
          <!-- Persistence is the one parameter that changes what the piece
               means: ephemeral touches versus an enduring collective map. -->
          <div class="pop-ctrl">
            <span class="pop-name">Persistence</span>
            <span class="pop-widget">
              <input type="range" min="0" max="1" step="0.01" data-k="persist" />
              <span class="pop-val" data-k="persistVal">0.00</span>
            </span>
          </div>
          <div class="tp-scale"><span>ephemeral</span><span>enduring</span></div>
          <div class="pop-ctrl">
            <span class="pop-name">Traces</span>
            <span class="pop-widget"><button class="pop-btn" data-act="clear" type="button">Clear</button></span>
          </div>
        </div>

        <div class="pop-sec">
          <div class="pop-sec-title">Your participation</div>
          <div class="pop-sec-sub">Every click you contributed, as a visualization or as raw data</div>
          <button class="tp-export" data-act="field" type="button">
            <span class="tp-ex-name">Interaction Field</span><span class="tp-ex-fmt">PNG</span>
          </button>
          <button class="tp-export" data-act="trajectory" type="button">
            <span class="tp-ex-name">Trajectory</span><span class="tp-ex-fmt">HTML</span>
          </button>
          <button class="tp-export" data-act="data" type="button">
            <span class="tp-ex-name">Session Data</span><span class="tp-ex-fmt">CSV</span>
          </button>
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

    const run = (fn) => { if (typeof fn === "function") fn(); };
    this.el.querySelector('[data-act="field"]')
      .addEventListener("click", () => run(this.exports.field));
    this.el.querySelector('[data-act="trajectory"]')
      .addEventListener("click", () => run(this.exports.trajectory));
    this.el.querySelector('[data-act="data"]')
      .addEventListener("click", () => run(this.exports.data));

    // Outside click dismisses. Captured so it runs before downstream handlers,
    // and the Playbar's own Trace button is skipped so its toggle is not
    // fought by an immediate re-close.
    this._onOutsidePointerDown = (e) => {
      if (!this.open) return;
      if (this.el.contains(e.target)) return;
      if (e.target?.closest?.('[data-act="trace"], .lil-gui')) return;
      this.close();
    };

    this.sync();
  }

  // Mirror recorder state into the panel. Cheap enough to call on a timer
  // while open; skipped entirely while closed.
  sync() {
    if (!this.el) return;
    const t = this.tracker;
    const n = t.log?.length || 0;
    const on = !!t.params.enable;

    this.$.count.textContent = n;
    this.$.label.textContent = t.sessionLabel();
    // Recording is on from load, so the header label is a state readout. It
    // still reflects the flag in case the Studio folder toggles it.
    this.$.rec.textContent = on ? "Rec" : "Paused";
    this.$.rec.classList.toggle("off", !on);

    const p = t.params.persistence ?? 0;
    if (document.activeElement !== this.$.persist) this.$.persist.value = p;
    this.$.persistVal.textContent = Number(p).toFixed(2);

    // Exports are meaningless with an empty log; disable rather than let them
    // fail into a toast.
    this.el.querySelectorAll(".tp-export").forEach(b => { b.disabled = n === 0; });
    this.$.hint.textContent = on
      ? (n ? "Traces accumulate until cleared" : "Click or pinch the scene to leave a trace")
      : "Recording is off";
  }

  show() {
    this.open = true;
    this.el.classList.add("show");
    this.sync();
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
