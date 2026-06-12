// ---------------------------------------------------------------------------
// UsdLayers — left-side panel for the three render representations
// (Splat / Billboard / Voxel). Each row carries:
//   * eye icon          — toggle visibility (drives controller.setLayerVis)
//   * name              — Splat | Billboard | Voxel
//   * subform pills     — Gaussian/Point, Quad/Circle, Cube/Sphere
//   * size slider       — Point Size, Billboard Size, Voxel Size
//
// Replaces the lil-gui "3DGS/USD" folder, which is hidden by main.js once
// this panel is mounted. Visual language matches SceneLayers (same eye SVG,
// same row-with-actions structure) so the left stack reads as a unified
// "what's in the scene" zone.
// ---------------------------------------------------------------------------

import { haptic }    from "./haptic.js";
import { playSound } from "./sounds.js";

const EYE_OPEN =`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF  = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`;

// Row definitions — each describes one layer family. `section` groups
// rows under a small all-caps section header in the panel:
//   3DGS  → the native gaussian-splat render
//   USD   → alternative renderings exposed as UsdGeomPointInstancer
//           prims (billboard plane, voxel cube/sphere)
// visKey is the boolean field on the params object; layerKey is the
// string the EffectController.setLayerVis() expects.
// `interactive` flags which layer carries mouse interactions (FX click
// triggers, hover hotspots, raycast). Only the Splat layer is wired
// into the raycaster + per-splat FX modifier; the USD Billboard and
// Voxel layers are view-only re-projections of the same point cloud
// and don't carry the per-instance event surface. Surfaced in the row
// UI as a small "view-only" tag so the user understands why clicking
// on a Voxel mesh doesn't fire FX.
const ROWS = [
  {
    id: "splat",
    section: "3DGS",
    name: "Splat",
    visKey: "splatLayer",
    layerKey: "splat",
    shapeKey: "splatSubform",
    sizeKey:  "pointSize",
    sizeLabel:"Point Size",
    // Useful range tightened from the old 0.0005-0.05 (100x): tiny dots
    // at 0.001, chunky dots at 0.01. Default 0.0025 sits ~20% in.
    sizeMin: 0.001, sizeMax: 0.01, sizeStep: 0.0001,
    // The size slider only makes sense in Point mode — Gaussian mode
    // reads each splat's own scale from the .splat data.
    sizeOnlyForShape: "Point",
    shapes: [
      { val: "Gaussian", label: "Gaussian" },
      { val: "Point",    label: "Point"    },
    ],
    badge: "Anisotropic 3D Gaussian",
    interactive: true,
  },
  {
    id: "billboard",
    section: "USD",
    name: "Billboard",
    visKey: "quadLayer",
    layerKey: "quad",
    shapeKey: "quadShape",
    sizeKey:  "quadSize",
    sizeLabel:"Billboard Size",
    // Tightened from 0.0001-0.05 (500x) to the visually useful slice;
    // default 0.0064 sits ~30% in.
    sizeMin: 0.001, sizeMax: 0.02, sizeStep: 0.0005,
    shapes: [
      { val: "quad",   label: "Quad"   },
      { val: "circle", label: "Circle" },
    ],
    badge: "PointInstancer › Plane",
    interactive: false,
  },
  {
    id: "voxel",
    section: "USD",
    name: "Voxel",
    visKey: "voxelLayer",
    layerKey: "voxel",
    shapeKey: "voxelShape",
    sizeKey:  "voxelSize",
    sizeLabel:"Voxel Size",
    // Old range went up to 0.40 (meter-scale boxes), unusable past ~0.05.
    // Tightened to the usable slice; default 0.013 sits ~18% in. Bigger
    // step than the others because each move queues a Voxelizer rebuild.
    sizeMin: 0.005, sizeMax: 0.05, sizeStep: 0.001,
    shapes: [
      { val: "cube",   label: "Cube"   },
      { val: "sphere", label: "Sphere" },
    ],
    badge: "PointInstancer › Cube · Sphere",
    interactive: false,
  },
];

const SECTION_BLURBS = {
  "3DGS": "Native render",
  "USD":  "OpenUSD alternative renderings",
};

export class UsdLayers {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.mountEl
   * @param {object} opts.params           — effects.params (shared)
   * @param {object} opts.controller       — EffectController with
   *                                          setLayerVis() and applyParams()
   * @param {(shape:string)=>void} opts.onQuadShape  — quadizer.setShape proxy
   * @param {(shape:string)=>void} opts.onVoxelShape — voxelizer.setShape proxy
   * @param {(size:number)=>void}  opts.onQuadSize   — quadizer.setQuadSize
   * @param {(size:number)=>void}  opts.onVoxelSize  — voxelizer.setVoxelSize
   */
  constructor({ mountEl, params, controller, onQuadShape, onVoxelShape, onQuadSize, onVoxelSize, onUploadRequest, onLayerActivate }) {
    this.params       = params;
    this.controller   = controller;
    this.onQuadShape  = onQuadShape;
    this.onVoxelShape = onVoxelShape;
    this.onQuadSize   = onQuadSize;
    this.onVoxelSize  = onVoxelSize;
    this.onUploadRequest = onUploadRequest;
    // Called with the layer key ("splat" | "quad" | "voxel") whenever the
    // user manually toggles a layer ON via the eye icon. Used by main.js
    // to fire a museum-style annotation overlay. Programmatic toggles
    // (camera move) do NOT route through here.
    this.onLayerActivate = onLayerActivate;

    this.el = document.createElement("aside");
    this.el.id = "usd-layers-panel";
    // NO inner header — the panel is mounted INSIDE a real lil-gui
    // folder ("3DGS / USD"), and lil-gui's own folder title + caret
    // + fold animation give us perfect visual parity with the
    // sibling folders (Customize / Cinematic FX / Tech Spec / Camera
    // Movement). Our content is just the rows + the secondary
    // "Use My Own" action below them; a tiny multi-select cue sits
    // above the rows so the toggle-switch behaviour reads explicitly.
    // Persist the per-upload max-range value across reloads so a user
    // who knows their pipeline ships big bboxes doesn't have to retype
    // the cap every visit. Empty value (or NaN after parse) → no cap,
    // auto-detected radius wins.
    const MAX_RANGE_KEY = "splatgarden:uploadMaxRange";
    let savedRange = "";
    try { savedRange = localStorage.getItem(MAX_RANGE_KEY) || ""; } catch {}

    this.el.innerHTML = `
      <div class="usd-hint">Toggle layers · stack freely · only Splat takes mouse interactions</div>
      <ul class="usd-row-list"></ul>
      <div class="usd-upload-row">
        <label class="usd-max-range" title="Cap the auto-reframe radius when loading your own splat. Useful when an export has outlier points that would otherwise push the camera too far away. Leave blank for auto-detected.">
          <span class="usd-max-range-label">Max range (m)</span>
          <input type="number" class="usd-max-range-input"
                 min="0.1" max="500" step="0.1"
                 inputmode="decimal"
                 placeholder="auto"
                 value="${savedRange}">
        </label>
        <button class="usd-upload" title="Replace the primary splat by dropping a .splat / .ply / .spz / .ksplat">⤓ Use My Own</button>
      </div>
    `;
    mountEl.appendChild(this.el);

    this.listEl = this.el.querySelector(".usd-row-list");
    this.hintEl = this.el.querySelector(".usd-hint");
    this.el.querySelector(".usd-upload")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onUploadRequest?.();
    });

    // Max-range input — drives the camera reframe cap for "Use My Own".
    // Value is persisted to localStorage and mirrored on window so
    // addSplatLayer (in main.js) can read it without a callback hop.
    // Parse fence: empty / NaN / non-positive → no cap (auto wins).
    const maxRangeInput = this.el.querySelector(".usd-max-range-input");
    const syncMaxRange = () => {
      const raw = maxRangeInput?.value?.trim() ?? "";
      const parsed = raw === "" ? NaN : parseFloat(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        window.__uploadMaxRange = parsed;
        try { localStorage.setItem(MAX_RANGE_KEY, raw); } catch {}
      } else {
        window.__uploadMaxRange = null;
        try { localStorage.removeItem(MAX_RANGE_KEY); } catch {}
      }
    };
    // Initialise window value from the saved string so a reload that
    // hits a queued upload picks up the user's cap immediately.
    syncMaxRange();
    maxRangeInput?.addEventListener("input",  syncMaxRange);
    maxRangeInput?.addEventListener("change", syncMaxRange);
    // Don't let typing into the input fire the panel's click-anywhere
    // handlers (lil-gui folder toggle, etc.).
    maxRangeInput?.addEventListener("click",     (e) => e.stopPropagation());
    maxRangeInput?.addEventListener("pointerdown", (e) => e.stopPropagation());

    // Behavioural hint: the small "stack freely" caption is only meta-
    // information until the user has actually clicked a toggle. Once
    // they do, the caption has done its job — fade it out and remember
    // so it doesn't reappear next session. Pure UX move: the textual
    // hint is a crutch that should self-retire as soon as the user's
    // own action proves they understood the multi-select.
    const HINT_KEY = "splatgarden:usd-hint-seen";
    try {
      if (localStorage.getItem(HINT_KEY) === "1" && this.hintEl) {
        this.hintEl.classList.add("dismissed");
      }
    } catch {}
    this._dismissHintOnFirstToggle = () => {
      if (!this.hintEl || this.hintEl.classList.contains("dismissed")) return;
      this.hintEl.classList.add("dismissed");
      try { localStorage.setItem(HINT_KEY, "1"); } catch {}
    };

    this._render();
  }

  // Map a shape-row id to the proxy that drives the underlying renderer.
  _runShapeCallback(rowId, val) {
    if (rowId === "billboard") this.onQuadShape?.(val);
    else if (rowId === "voxel") this.onVoxelShape?.(val);
    // splat doesn't need an external callback — applyParams() picks it up.
  }

  _setVisible(row, on) {
    // Snap-style micro-feedback for the toggle event. Both no-op
    // gracefully on platforms without their respective APIs.
    haptic(6);
    playSound("tic");
    this.params[row.visKey] = !!on;
    this.controller?.setLayerVis(row.layerKey, !!on);
    if (on) this.onLayerActivate?.(row.layerKey);
    // Surface the mouse-interaction constraint when it actually
    // matters. Three cases worth telling the user about:
    //   1. Splat → OFF      : interactions go away entirely. Warn.
    //   2. Splat → ON       : interactions come back. Confirm quietly.
    //   3. Billboard/Voxel → ON while Splat is OFF : they enabled a
    //      view-only layer with no Splat fallback; still no clicks.
    // Toast helper is exposed on window from main.js. Optional chain
    // keeps this safe during HMR / standalone imports.
    if (row.id === "splat") {
      if (on) window.__toast?.("Splat layer on — mouse interactions live");
      else    window.__toast?.("Splat layer off — mouse clicks and hotspots paused");
    } else if (on && this.params.splatLayer === false) {
      window.__toast?.(`${row.name} is view-only — turn Splat on for mouse interactions`);
    }
    this._render();
  }

  _setShape(row, val) {
    this.params[row.shapeKey] = val;
    this.controller?.applyParams?.();
    this._runShapeCallback(row.id, val);
    this._render();
  }

  _setSize(row, val) {
    this.params[row.sizeKey] = val;
    this.controller?.applyParams?.();
    // Quadizer and Voxelizer each own their own ShaderMaterial uniforms —
    // applyParams() only touches effects.js' effectUniforms, so push the
    // size directly to the right renderer here.
    if (row.id === "billboard") this.onQuadSize?.(val);
    if (row.id === "voxel")     this.onVoxelSize?.(val);
    // Live size update for the value chip — no full re-render needed.
    const valEl = this.listEl?.querySelector(`.usd-row[data-id="${row.id}"] .usd-size-val`);
    if (valEl) valEl.textContent = val.toFixed(row.sizeStep < 0.001 ? 4 : 3);
  }

  _render() {
    if (!this.listEl) return;
    let html = "";
    // Inner "3DGS" / "USD" section sub-headers were intentionally
    // dropped to match the lil-gui folder visual style (Post-Process,
    // HDR Sky, etc.). The panel reads as one flat list of rows under
    // the single folder-style header "3DGS / USD".
    for (const row of ROWS) {
      const on  = this.params[row.visKey] !== false;
      const cur = this.params[row.shapeKey];
      const pills = row.shapes.map(s => `
        <button class="usd-pill ${s.val === cur ? "active" : ""}"
                data-act="shape" data-val="${s.val}">${s.label}</button>
      `).join("");
      const sizeVal = Number(this.params[row.sizeKey] ?? 0);
      const decimals = row.sizeStep < 0.001 ? 4 : 3;
      // Hide the size slider when the active subform doesn't use it
      // (Splat row hides Point Size while in Gaussian mode).
      const showSize = !row.sizeOnlyForShape || row.sizeOnlyForShape === cur;
      const sizeHTML = showSize ? `
            <label class="usd-size">
              <span class="usd-size-label">${row.sizeLabel}</span>
              <input type="range" data-act="size"
                     min="${row.sizeMin}" max="${row.sizeMax}" step="${row.sizeStep}"
                     value="${sizeVal}">
              <span class="usd-size-val">${sizeVal.toFixed(decimals)}</span>
            </label>` : "";
      // "view-only" tag for non-interactive rows. The Splat layer is
      // the one wired into the raycaster + FX modifier; Billboard and
      // Voxel are pure visual re-projections and clicking on them
      // doesn't trigger FX or hotspots. The tag is a small monochrome
      // pill with a tooltip explaining the why — surfaced inline so
      // the limitation is discoverable from the panel rather than via
      // trial-and-error in the canvas.
      const interactivityTag = row.interactive === false
        ? `<span class="usd-noninteract" title="View-only — mouse clicks and hover hotspots only work on the Splat layer.">view only</span>`
        : "";
      html += `
        <li class="usd-row ${on ? "" : "hidden-row"} ${row.interactive === false ? "non-interactive" : ""}" data-id="${row.id}">
          <div class="usd-row-main">
            <button class="usd-toggle ${on ? "on" : ""}" data-act="toggle"
                    role="switch" aria-checked="${on}"
                    title="${on ? "Hide" : "Show"} ${row.name} (layers stack, so toggle any combination)">
              <span class="usd-toggle-knob"></span>
            </button>
            <span class="usd-name">${row.name}</span>
            ${interactivityTag}
            <span class="usd-badge" title="${row.badge}">${row.badge}</span>
          </div>
          <div class="usd-row-sub">
            <div class="usd-pill-group">${pills}</div>
            ${sizeHTML}
          </div>
        </li>
      `;
    }
    this.listEl.innerHTML = html;

    // Wire row buttons. currentTarget so clicks land on the button even
    // when the eye SVG is the literal event target.
    this.listEl.querySelectorAll("[data-act]").forEach(btn => {
      btn.addEventListener(btn.tagName === "INPUT" ? "input" : "click", (e) => {
        const rowEl = e.currentTarget.closest(".usd-row");
        const rowId = rowEl?.dataset.id;
        const row   = ROWS.find(r => r.id === rowId);
        if (!row) return;
        const act   = e.currentTarget.dataset.act;
        if (act === "toggle") {
          this._setVisible(row, this.params[row.visKey] === false);
          this._dismissHintOnFirstToggle?.();
        } else if (act === "shape") {
          // Picking a subform pill (Circle / Sphere / Point …) is a
          // strong signal of intent — the user wants to SEE that
          // shape rendered. Auto-enable the layer if it was off so
          // they don't have to flip both the toggle AND the pill
          // (two-step interaction users repeatedly missed: they'd
          // tap "Circle", nothing visible would change because
          // Billboard was off, and they'd assume the pill was
          // broken). Now one tap on any subform turns its layer on.
          if (this.params[row.visKey] === false) {
            this._setVisible(row, true);
            this._dismissHintOnFirstToggle?.();
          }
          this._setShape(row, e.currentTarget.dataset.val);
        } else if (act === "size") {
          this._setSize(row, Number(e.currentTarget.value));
        }
      });
    });
  }

  // Allow main.js to push external changes (e.g. lil-gui still drives
  // params elsewhere). Re-renders to keep the panel in sync.
  refresh() { this._render(); }
}
