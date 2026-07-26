// ---------------------------------------------------------------------------
// Playbar — the progressive-disclosure layer over the lil-gui Studio panel.
//
// Product rationale: the right-rail lil-gui is a parameter-first debug
// surface (80+ controls organized by implementation module). A first-time
// visitor's real tasks are only three: switch representation, pick an
// effect, take the tour. The Playbar surfaces exactly those three as an
// outcome-first bottom bar; everything else stays one click away behind
// the STUDIO toggle, which shows/hides the untouched lil-gui.
//
// Wiring strategy: the bar does NOT own any state. Every action routes
// through the existing lil-gui controllers (found by property name via
// the same controller-walk idiom main.js already uses), so all side
// effects fire exactly as if the user had clicked the Studio checkbox:
// UsdLayers eye sync, voxel/quad lazy rebuilds, annotation cards, the
// shader cross-fade. A light poll keeps button states mirrored when the
// same params are changed from the Studio panel or the camera move.
//
// Desktop-only: body.touch gets the existing mobile bottom-bar instead
// (mobile-ui.js); the Playbar is display:none under body.touch and under
// 900px viewport width (CSS).
// ---------------------------------------------------------------------------

// Short chip labels — the full EFFECT_INDEX names are too wide for a
// single-row bar. Keys are display labels, values are the canonical
// params.effect names the gui dropdown expects.
const EFFECT_CHIPS = {
  Wave:    "Wave & Tint",
  Dissolve: "Dissolve & Reform",
  Scan:    "Scan Line",
  Spiral:  "Spiral Smear",
  Vortex:  "Vortex Drift",
  Chaos:   "Chaotic Particles",
  Slime:   "Slime Molds",
  Feather: "Feather Roots",
};

export class Playbar {
  /**
   * @param {object} opts
   * @param {*}      opts.gui     — lil-gui root (controllers are resolved from it)
   * @param {object} opts.params  — effects.js params object (read-only mirror)
   * @param {HTMLElement} [opts.mountEl]
   */
  constructor({ gui, params, mountEl = document.body }) {
    this.gui = gui;
    this.params = params;
    this.ctrls = this._collectControllers(gui);

    this.el = document.createElement("div");
    this.el.id = "playbar";
    this.el.innerHTML = `
      <div class="pb-group pb-layers" role="group" aria-label="Representation">
        <button class="pb-btn" data-layer="splatLayer">Splat<span class="pb-gear" data-gear="splatLayer" title="Splat parameters">&#9679;</span></button>
        <span class="pb-sub" data-sub-for="splatLayer">
          <button class="pb-subchip" data-subval="Gaussian">Gaussian</button>
          <button class="pb-subchip" data-subval="Point">Point</button>
        </span>
        <button class="pb-btn" data-layer="quadLayer">Billboard<span class="pb-gear" data-gear="quadLayer" title="Billboard parameters">&#9679;</span></button>
        <span class="pb-sub" data-sub-for="quadLayer">
          <button class="pb-subchip" data-subval="quad">Quad</button>
          <button class="pb-subchip" data-subval="circle">Circle</button>
        </span>
        <button class="pb-btn" data-layer="voxelLayer">Voxel<span class="pb-gear" data-gear="voxelLayer" title="Voxel parameters">&#9679;</span></button>
        <span class="pb-sub" data-sub-for="voxelLayer">
          <button class="pb-subchip" data-subval="cube">Cube</button>
          <button class="pb-subchip" data-subval="sphere">Sphere</button>
        </span>
      </div>
      <div class="pb-sep" aria-hidden="true"></div>
      <div class="pb-group pb-fx" role="group" aria-label="Click effect">
        ${Object.keys(EFFECT_CHIPS).map(label =>
          `<button class="pb-chip" data-effect="${EFFECT_CHIPS[label]}">${label}` +
          `<span class="pb-gear" data-gear="effect" title="Effect parameters">&#9679;</span></button>`
        ).join("")}
      </div>
      <div class="pb-sep" aria-hidden="true"></div>
      <div class="pb-group pb-actions">
        <button class="pb-btn pb-tour" data-act="tour" title="Play the camera tour">&#9654; Tour</button>
        <button class="pb-btn pb-trace" data-act="trace" title="Interaction Trace — record, review and export this session">
          Trace<span class="pb-badge" data-k="traceCount" hidden>0</span>
        </button>
        <button class="pb-btn pb-studio" data-act="studio" title="Open the full Studio panel (every parameter)">Studio</button>
      </div>
    `;
    mountEl.appendChild(this.el);

    // --- Module parameter popovers ----------------------------------------
    // The dot on an active button opens that module's own controls, so a
    // visitor can tune what they just engaged without leaving the bar for the
    // full Studio panel. Registered before the toggle handlers and stopping
    // propagation so a caret click never flips the layer it belongs to.
    this.el.querySelectorAll(".pb-gear").forEach(gear => {
      gear.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        window.__modulePopover?.toggleFor?.(gear.dataset.gear, gear.closest("button"));
        this._sync();
      });
    });

    // --- Representation toggles ------------------------------------------
    this.el.querySelectorAll("[data-layer]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        if (e.target?.closest?.(".pb-gear")) return;
        const key = btn.dataset.layer;
        const ctrl = this.ctrls[key];
        if (!ctrl) return;
        ctrl.setValue(!this.params[key]);   // fires the full onChange chain
        this._sync();
      });
    });

    // --- Sub-form pills (Gaussian/Point · Quad/Circle · Cube/Sphere) -------
    // Shown only while their representation is active. Clicks are PROXIED to
    // the Studio panel's original segmented buttons (hidden but in the DOM),
    // so the full handler chain runs: params write, quadizer/voxelizer
    // setShape callbacks, debounced rebuilds, and the Studio's own visual
    // sync. data-val values are unique across all three groups, so a single
    // selector resolves the right button.
    this.el.querySelectorAll(".pb-subchip").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.gui.domElement
          ?.querySelector(`.subform-toggle button[data-val="${btn.dataset.subval}"]`)
          ?.click();
        this._sync();
      });
    });

    // --- Effect chips (radio semantics) -----------------------------------
    this.el.querySelectorAll("[data-effect]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        if (e.target?.closest?.(".pb-gear")) return;
        this.ctrls.effect?.setValue(btn.dataset.effect);
        this._sync();
      });
    });

    // --- Tour / Studio -----------------------------------------------------
    this.el.querySelector('[data-act="tour"]').addEventListener("click", () => {
      // __tourToggle routes to the authored cinematic for the bundled scene
      // and to the procedural bbox turntable for any other loaded layer.
      (window.__tourToggle || window.__camMovePlayPause)?.();
    });
    this.el.querySelector('[data-act="studio"]').addEventListener("click", () => {
      this.setStudioOpen(this.gui._hidden === true);
    });
    // Trace opens the recorder's own popup. Resolved at click time because the
    // panel is constructed after the bar in main.js.
    this.el.querySelector('[data-act="trace"]').addEventListener("click", () => {
      window.__tracePanel?.toggle?.();
      this._sync();
    });

    // State mirroring is driven per-frame from the render loop (main.js calls
    // syncIfDirty()), not a timer: a 400ms poll left a visible lag between a
    // Studio-panel change and the bar catching up ("the bar doesn't sync").
    // syncIfDirty() is a cheap string-signature compare that only touches the
    // DOM when something actually changed, so per-frame cost is negligible.
    this._lastSig = null;
    this._sync();
  }

  // Frame-driven mirror: recompute a compact signature of every state the
  // bar reflects; only repaint when it differs from last frame.
  syncIfDirty() {
    const p = this.params;
    const sig = `${!!p.splatLayer}|${!!p.quadLayer}|${!!p.voxelLayer}|`
              + `${p.splatSubform}|${p.quadShape}|${p.voxelShape}|`
              + `${p.effect}|${this.gui._hidden !== true}|`
              // Trace count + panel state: the badge is how a visitor sees
              // their touches accumulating without opening anything.
              + `${window.__blobTracker?.log?.length || 0}|${!!window.__tracePanel?.open}`;
    if (sig === this._lastSig) return;
    this._lastSig = sig;
    this._sync();
  }

  // Resolve the lil-gui controllers the bar drives. Same walk idiom the
  // Voxel Size / Quad Size re-wiring in main.js uses.
  _collectControllers(gui) {
    const found = {};
    const walk = (g) => {
      (g.controllers || []).forEach(c => { if (!(c.property in found)) found[c.property] = c; });
      (g.folders || []).forEach(walk);
    };
    walk(gui);
    return found;
  }

  // Show/hide the full lil-gui Studio panel. The gui starts hidden on
  // desktop (set in main.js right after Playbar construction) so first
  // paint leads with the three core actions; STUDIO restores the expert
  // surface without losing any of its state.
  setStudioOpen(open) {
    if (open) this.gui.show(); else this.gui.hide();
    this._sync();
  }

  _sync() {
    const p = this.params;
    this.el.querySelectorAll("[data-layer]").forEach(btn => {
      btn.classList.toggle("active", !!p[btn.dataset.layer]);
    });
    // Sub-form pills: visible only while their representation is active;
    // selection mirrors the params the Studio buttons write.
    const subState = {
      splatLayer: p.splatSubform,   // "Gaussian" | "Point"
      quadLayer:  p.quadShape,      // "quad" | "circle"
      voxelLayer: p.voxelShape,     // "cube" | "sphere"
    };
    this.el.querySelectorAll(".pb-sub").forEach(sub => {
      const layer = sub.dataset.subFor;
      sub.classList.toggle("show", !!p[layer]);
      sub.querySelectorAll(".pb-subchip").forEach(chip => {
        chip.classList.toggle("active", chip.dataset.subval === subState[layer]);
      });
    });
    this.el.querySelectorAll("[data-effect]").forEach(btn => {
      btn.classList.toggle("active", p.effect === btn.dataset.effect);
    });
    const studioBtn = this.el.querySelector(".pb-studio");
    if (studioBtn) studioBtn.classList.toggle("active", this.gui._hidden !== true);

    // Trace: highlight while its panel is open, and carry a live count badge
    // so the accumulating session is visible from the bar itself.
    const traceBtn = this.el.querySelector(".pb-trace");
    if (traceBtn) {
      traceBtn.classList.toggle("active", !!window.__tracePanel?.open);
      const n = window.__blobTracker?.log?.length || 0;
      const badge = traceBtn.querySelector(".pb-badge");
      if (badge) {
        badge.textContent = n > 999 ? "999+" : n;
        badge.hidden = n === 0;
      }
    }
  }

  dispose() {
    this.el.remove();
  }
}
