// ---------------------------------------------------------------------------
// SceneLayers — manages the list of splat layers in the scene and renders a
// SuperSplat-style panel with per-layer visibility toggle + delete.
//
// V1 contract:
//   - First layer added = primary. Effects / voxelizer / quadizer / annotations
//     bind to its mesh and never move. Primary cannot be removed.
//   - Drag-drop and "+ Add" append secondary layers. They render alongside the
//     primary, can be toggled visible/hidden, and removed.
//   - All layers live in the same Three scene; nothing here owns the scene
//     graph beyond attach / detach on add / remove.
// ---------------------------------------------------------------------------

function shortId() {
  return Math.random().toString(36).slice(2, 8);
}

function compactInt(n) {
  if (!Number.isFinite(n)) return "";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function fileLabel(name) {
  if (!name) return "Untitled";
  return name.replace(/\.(splat|ply|spz|ksplat)$/i, "");
}

// Lucide-style eye / eye-off icons. Inline SVG so colour follows currentColor.
const EYE_OPEN = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF  = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`;

export class SceneLayers {
  constructor({ scene, mountEl = document.body, panelEl = null } = {}) {
    this.scene  = scene;
    this.layers = [];

    // onAddRequest fires when the user clicks "+ Add" — the host wires this
    // to its existing file-picker / replaceSplatMesh path.
    this.onAddRequest = null;

    if (panelEl) {
      this.el = panelEl;
      this._wirePanel();
    } else {
      this._buildPanel(mountEl);
    }
    this._render();
  }

  add({ mesh, name, isPrimary = null }) {
    if (!mesh) return null;
    if (isPrimary === null) isPrimary = this.layers.length === 0;
    const layer = {
      id:        shortId(),
      name:      fileLabel(name),
      mesh,
      visible:   true,
      isPrimary: !!isPrimary,
    };
    if (isPrimary) this.layers.forEach(l => (l.isPrimary = false));
    this.layers.push(layer);
    mesh.visible = true;
    if (mesh.parent !== this.scene) this.scene.add(mesh);
    this._render();
    return layer;
  }

  remove(id) {
    const idx = this.layers.findIndex(l => l.id === id);
    if (idx < 0) return false;
    const layer = this.layers[idx];
    if (layer.isPrimary) return false;        // primary is immutable in v1
    if (layer.mesh?.parent) layer.mesh.parent.remove(layer.mesh);
    if (typeof layer.mesh?.dispose === "function") {
      try { layer.mesh.dispose(); } catch {}
    }
    this.layers.splice(idx, 1);
    this._render();
    return true;
  }

  setVisible(id, on) {
    const layer = this.layers.find(l => l.id === id);
    if (!layer) return;
    layer.visible = !!on;
    if (layer.mesh) layer.mesh.visible = layer.visible;
    this._render();
    // Bubble the change to any subscriber (main.js wires this to
    // effects.setLayerVis so the 3DGS/USD shader-alpha follows the
    // Scene-panel eye — without that bridge, hiding the primary
    // here leaves the shader still rendering at alpha 1.0).
    this.onVisibilityChange?.(id, layer.visible, layer.isPrimary);
  }

  // Replace the primary layer's mesh in-place (used by the existing
  // replaceSplatMesh hot-swap path). Keeps the layer id stable.
  replacePrimaryMesh(mesh, name) {
    const primary = this.layers.find(l => l.isPrimary);
    if (!primary) return this.add({ mesh, name, isPrimary: true });
    if (primary.mesh?.parent) primary.mesh.parent.remove(primary.mesh);
    if (typeof primary.mesh?.dispose === "function") {
      try { primary.mesh.dispose(); } catch {}
    }
    primary.mesh    = mesh;
    primary.name    = fileLabel(name);
    primary.visible = true;
    mesh.visible    = true;
    if (mesh.parent !== this.scene) this.scene.add(mesh);
    this._render();
    return primary;
  }

  getPrimary() { return this.layers.find(l => l.isPrimary) || null; }

  // ---- Active / interactive layer ----------------------------------------
  // "Interactive" = the splat layer that effects + raycast + voxelizer should
  // bind to. The model: primary wins if visible, otherwise the topmost OTHER
  // visible layer. Returns null if every layer is hidden (interactions cleanly
  // no-op rather than secretly firing on an invisible primary, which is the
  // bug the user reported: "import a second 3DGS, hide primary, secondary
  // doesn't respond to clicks").
  getInteractive() {
    const prim = this.getPrimary();
    if (prim?.visible) return prim;
    // Fall back to the most-recently-added visible secondary (last in array).
    for (let i = this.layers.length - 1; i >= 0; i--) {
      if (this.layers[i].visible) return this.layers[i];
    }
    return null;
  }

  // All currently-visible meshes — used by the raycaster so a click on ANY
  // visible layer registers (not just the primary). The order doesn't matter
  // because Raycaster.intersectObjects already sorts by distance.
  getVisibleMeshes() {
    return this.layers.filter(l => l.visible && l.mesh).map(l => l.mesh);
  }

  // (A/B Compare mode was removed — the V1 split-screen-wipe had several
  // unfinished pieces: the centre divider line wasn't draggable, it
  // overlapped the hand-tracking UI, and there was no mouse-interaction
  // lockout while compare was active. The feature is parked rather than
  // shipped half-built. If revived, design it around a dedicated overlay
  // layer that disables raycast + hand-cursor + hotspot pointer-events
  // for the duration, with the divider as a first-class draggable handle.)

  // ---- Panel ---------------------------------------------------------------

  _buildPanel(mountEl) {
    this.el = document.createElement("aside");
    this.el.id = "scene-panel";
    // Chevron-left button on the LEFT of the header collapses the panel
    // off-screen (same shape as the Viewpoints sidebar collapse — JS in
    // main.js wires the slide + floating expand handle).
    this.el.innerHTML = `
      <header>
        <button id="scene-toggle" class="sidebar-toggle" title="Collapse panel" aria-label="Collapse panel" aria-expanded="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="14 6 8 12 14 18"/>
          </svg>
        </button>
        <div class="title">Scene</div>
        <button class="add-splat" title="Add a splat layer (or drag a file onto the scene)">+ Add</button>
      </header>
      <ul class="layer-list"></ul>
      <div class="hint">
        Drag .splat / .ply / .spz onto the scene to add a layer.
      </div>
    `;
    mountEl.appendChild(this.el);
    this._wirePanel();
  }

  _wirePanel() {
    this.listEl = this.el.querySelector(".layer-list");
    this.addBtn = this.el.querySelector(".add-splat");
    if (this.addBtn) {
      this.addBtn.addEventListener("click", () => this.onAddRequest?.());
    }
    // (Collapse wiring is centralised in main.js — see setupCollapsiblePanel.
    // The chevron above is the click target; main.js attaches the slide
    // + floating expand handle + localStorage persistence.)
  }

  _render() {
    if (!this.listEl) return;
    if (this.layers.length === 0) {
      this.listEl.innerHTML = `<li class="empty">No splats loaded</li>`;
      return;
    }
    this.listEl.innerHTML = this.layers.map(l => {
      const splatCount = l.mesh?.packedSplats?.numSplats;
      const countTxt   = Number.isFinite(splatCount) ? compactInt(splatCount) : "";
      return `
        <li class="layer ${l.visible ? "" : "hidden-layer"} ${l.isPrimary ? "primary" : ""}" data-id="${l.id}">
          <button class="eye" data-act="toggle" title="${l.visible ? "Hide" : "Show"} layer">${l.visible ? EYE_OPEN : EYE_OFF}</button>
          <span class="name" title="${l.name}">${l.name}</span>
          <span class="count" title="${splatCount?.toLocaleString?.("en-US") || ""}">${countTxt}</span>
          ${l.isPrimary ? `<span class="badge">PRI</span>` : `<button class="del" data-act="del" title="Remove layer">×</button>`}
        </li>
      `;
    }).join("");

    // Wire row buttons. currentTarget (not target) so clicks on the inline
    // SVG inside the eye button still resolve to the button's data-act.
    this.listEl.querySelectorAll("[data-act]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const id  = e.currentTarget.closest("[data-id]")?.dataset.id;
        const act = e.currentTarget.dataset.act;
        if (!id) return;
        if (act === "toggle") {
          const layer = this.layers.find(l => l.id === id);
          if (layer) this.setVisible(id, !layer.visible);
        } else if (act === "del") {
          this.remove(id);
        }
      });
    });
  }
}
