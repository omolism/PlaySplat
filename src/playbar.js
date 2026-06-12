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

const SYNC_MS = 400;   // state-mirror poll; UI-latency only, not authority

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
        <button class="pb-btn" data-layer="splatLayer">Splat</button>
        <button class="pb-btn" data-layer="quadLayer">Billboard</button>
        <button class="pb-btn" data-layer="voxelLayer">Voxel</button>
      </div>
      <div class="pb-sep" aria-hidden="true"></div>
      <div class="pb-group pb-fx" role="group" aria-label="Click effect">
        ${Object.keys(EFFECT_CHIPS).map(label =>
          `<button class="pb-chip" data-effect="${EFFECT_CHIPS[label]}">${label}</button>`
        ).join("")}
      </div>
      <div class="pb-sep" aria-hidden="true"></div>
      <div class="pb-group pb-actions">
        <button class="pb-btn pb-tour" data-act="tour" title="Play the camera tour">&#9654; Tour</button>
        <button class="pb-btn pb-studio" data-act="studio" title="Open the full Studio panel (every parameter)">Studio</button>
      </div>
    `;
    mountEl.appendChild(this.el);

    // --- Representation toggles ------------------------------------------
    this.el.querySelectorAll("[data-layer]").forEach(btn => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.layer;
        const ctrl = this.ctrls[key];
        if (!ctrl) return;
        ctrl.setValue(!this.params[key]);   // fires the full onChange chain
        this._sync();
      });
    });

    // --- Effect chips (radio semantics) -----------------------------------
    this.el.querySelectorAll("[data-effect]").forEach(btn => {
      btn.addEventListener("click", () => {
        this.ctrls.effect?.setValue(btn.dataset.effect);
        this._sync();
      });
    });

    // --- Tour / Studio -----------------------------------------------------
    this.el.querySelector('[data-act="tour"]').addEventListener("click", () => {
      window.__camMovePlayPause?.();
    });
    this.el.querySelector('[data-act="studio"]').addEventListener("click", () => {
      this.setStudioOpen(this.gui._hidden === true);
    });

    // Keep button states mirrored when params change from the Studio panel,
    // the mobile sheet, or programmatic camera-move toggles. Polling beats
    // monkey-patching every controller's onChange, and 400 ms is invisible
    // for a state highlight.
    this._timer = setInterval(() => this._sync(), SYNC_MS);
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
    this.el.querySelectorAll("[data-effect]").forEach(btn => {
      btn.classList.toggle("active", p.effect === btn.dataset.effect);
    });
    const studioBtn = this.el.querySelector(".pb-studio");
    if (studioBtn) studioBtn.classList.toggle("active", this.gui._hidden !== true);
  }

  dispose() {
    clearInterval(this._timer);
    this.el.remove();
  }
}
