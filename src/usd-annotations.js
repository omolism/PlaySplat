// ---------------------------------------------------------------------------
// UsdAnnotations — museum-style annotation card that pops up when the user
// manually toggles a layer ON via the 3DGS/USD panel. Educates the viewer
// on what they're looking at without crowding the lil-gui side.
//
// Triggered from UsdLayers (not from controller.setLayerVis directly) so
// the camera-move's programmatic toggles don't fire annotations during the
// cinematic. Auto-dismisses after AUTO_HIDE_MS unless the user re-toggles
// (which restarts the timer) or clicks the close button.
// ---------------------------------------------------------------------------

// Bumped 7500 → 14000 per user feedback: the Voxel / Billboard popups
// went away before they could finish reading the body copy. 14 s gives a
// comfortable read window without overstaying — re-toggling the layer
// restarts the timer, so users who linger get plenty of time, and the
// close button is always available for the impatient.
const AUTO_HIDE_MS = 14000;

// Inline icon glyphs — small, monochrome line-art matching the iOS
// reference (wind / UV / humidity / rain pictograms). Each tile in the
// 2×2 fact grid carries one of these so the row reads at a glance.
const ICONS = {
  // "Gaussian" — a soft anisotropic ellipsoid
  gaussian: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <ellipse cx="12" cy="12" rx="8" ry="5" transform="rotate(-20 12 12)"/>
              <ellipse cx="12" cy="12" rx="4" ry="2.4" transform="rotate(-20 12 12)" opacity="0.6"/>
            </svg>`,
  // "Plane" — square prototype
  plane:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <rect x="4.5" y="4.5" width="15" height="15" rx="1.5"/>
            </svg>`,
  // "Cube" — 3D box
  cube:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/>
              <path d="M12 3v18M4 7.5l8 4.5 8-4.5"/>
            </svg>`,
  // "Sphere" — circle with latitude
  sphere:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="8"/>
              <ellipse cx="12" cy="12" rx="8" ry="3.2"/>
            </svg>`,
  // "Instance" — 3 dots in a triangle (point-instancer hint)
  instance:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="6"  cy="17" r="1.6" fill="currentColor"/>
              <circle cx="18" cy="17" r="1.6" fill="currentColor"/>
              <circle cx="12" cy="6"  r="1.6" fill="currentColor"/>
            </svg>`,
  // "Palette" — colour primvar
  palette: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-0.5-1.6-0.5-2.4c0-0.8 0.6-1.6 1.5-1.6h2c2 0 3-1.5 3-3.5C20 6.6 16.4 3 12 3z"/>
              <circle cx="8"  cy="9.5" r="1" fill="currentColor"/>
              <circle cx="12" cy="7"   r="1" fill="currentColor"/>
              <circle cx="16" cy="9.5" r="1" fill="currentColor"/>
            </svg>`,
  // "Training" — neural-net layers cue
  train:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="5"  cy="6"  r="1.8"/>
              <circle cx="5"  cy="18" r="1.8"/>
              <circle cx="19" cy="12" r="1.8"/>
              <path d="M6.8 6.8 17.2 11M6.8 17.2 17.2 13"/>
            </svg>`,
  // "Layer / aggregate" — stack of horizontal lines
  stack:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <rect x="4" y="5"  width="16" height="3.5" rx="0.8"/>
              <rect x="4" y="11" width="16" height="3.5" rx="0.8" opacity="0.7"/>
              <rect x="4" y="17" width="16" height="3.5" rx="0.8" opacity="0.4"/>
            </svg>`,
};

// Annotation schema, rewritten in the spirit of the iOS reference
// the user supplied (Outer Hebrides weather widget). The old format
// dropped the user straight into "UsdGeomPointInstancer" jargon with
// no plain-language warm-up. The new schema mirrors the reference:
//
//   • title       — what this thing IS in one word ("Billboard")
//   • hero        — the single most-important value, big and bold
//                   ("Plane" — the geometry the user is now seeing)
//   • eyebrow     — short technical category line above the title,
//                   the way the weather card shows H:24° L:8° 6:01
//   • intro       — ONE friendly sentence: "what you're seeing"
//   • facts[]     — exactly 4 tiles for the 2×2 grid (matches the
//                   Wind / Humidity / UV / Rain layout). Each tile:
//                     { icon: "key", k: "Label", v: "Value" }
//   • body        — short italic paragraph at the bottom: "what we
//                   did" / why it's there. Same role as the
//                   "This scene captures the calm serenity…" copy
//                   in the reference.
//
// The intro is the layer in PLAIN ENGLISH; the facts grid carries
// the technical detail (still all there for power users); the body
// is the "why we built this" pitch. Three tiers of progressively
// more technical information so a casual viewer gets it AND a USD
// engineer sees the spec.
const ANNOTATIONS = {
  splat: {
    eyebrow: "3DGS · NATIVE",
    title:   "Splat",
    hero:    "Gaussian",
    intro:   "What you're seeing is the real splat. These are millions of tiny coloured Gaussians, the format the scene was actually trained as.",
    facts: [
      { icon: "gaussian", k: "Primitive",  v: "Anisotropic 3D Gaussian" },
      { icon: "palette",  k: "Per-splat",  v: "Pos · Scale · Rot · SH · α" },
      { icon: "train",    k: "Trainers",   v: "Postshot ‖ Lichtfeld" },
      { icon: "stack",    k: "Capture",    v: "~990 camera frames" },
    ],
    body:    "This is the home format. Every other render in the panel is the same 3M-point cloud re-expressed as something USD-friendly, which is useful for pipelines that don't read raw splats yet.",
  },
  quad: {
    eyebrow: "USD · POINT INSTANCER",
    title:   "Billboard",
    hero:    "Plane",
    intro:   "We swap each splat for a tiny flat card that always faces you. It is cheap, sharp, and reads as a sticker-style render.",
    facts: [
      { icon: "plane",    k: "Schema",    v: "PointInstancer" },
      { icon: "plane",    k: "Prototype", v: "UsdGeomPlane" },
      { icon: "instance", k: "Subforms",  v: "Quad · Circle" },
      { icon: "palette",  k: "Colour",    v: "primvars:displayColor" },
    ],
    body:    "Same point cloud, USD-native. Quad keeps the full square; Circle clips each card to a soft disc so the cloud reads as round impostors, a halfway look between flat decals and full Gaussians.",
  },
  voxel: {
    eyebrow: "USD · POINT INSTANCER",
    title:   "Voxel",
    hero:    "Cube / Sphere",
    intro:   "We chop the cloud into a uniform 3D grid and replace every cell with a single solid shape carrying the cell's average colour.",
    facts: [
      { icon: "cube",     k: "Schema",     v: "PointInstancer" },
      { icon: "cube",     k: "Prototypes", v: "UsdGeomCube · Sphere" },
      { icon: "instance", k: "Per-cell",   v: "Pos · Orient · Scale" },
      { icon: "palette",  k: "Aggregate",  v: "displayColor (cell mean)" },
    ],
    body:    "The chunkiest of the three subforms. Voxels are the easiest USD primitive to load into other DCCs, so this layer doubles as a friction-free hand-off format.",
  },
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export class UsdAnnotations {
  constructor({ mountEl = document.body } = {}) {
    this.el = document.createElement("aside");
    this.el.id = "usd-annotations";
    this.el.setAttribute("hidden", "");
    // New layout mirrors the iOS reference card the user shared:
    //   eyebrow caption (top-left)
    //   title (big) + hero value (big, right)
    //   intro line — friendly plain-language explanation
    //   2×2 facts grid — each tile = icon + tiny label + value
    //   body — italic "why we built this" paragraph
    //   close × top-right
    this.el.innerHTML = `
      <button class="ua-close" data-act="close" title="Dismiss" aria-label="Dismiss">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <line x1="6" y1="6" x2="18" y2="18"/>
          <line x1="18" y1="6" x2="6" y2="18"/>
        </svg>
      </button>
      <div class="ua-eyebrow" data-k="eyebrow"></div>
      <div class="ua-titleRow">
        <h3 class="ua-title" data-k="title"></h3>
        <div class="ua-hero" data-k="hero"></div>
      </div>
      <p class="ua-intro" data-k="intro"></p>
      <div class="ua-grid" data-k="facts"></div>
      <p class="ua-body" data-k="body"></p>
    `;
    mountEl.appendChild(this.el);

    this.el.querySelector('[data-act="close"]').addEventListener("click", () => this.hide());
    this._timer = null;

    // ----- Drag-to-reposition -----------------------------------------
    // Lets the user grab the card and move it anywhere on the viewport.
    // Pointer-capture-based so a drag started on the card keeps routing
    // events to it even if the finger / cursor slides off. Excludes the
    // close × button + fact tiles (those keep their own click semantics)
    // so the drag doesn't swallow taps on interactive sub-elements.
    //
    // First drag converts the right-anchored CSS position
    // (`right: 322 px / left: auto`) into explicit `left / top` pixels
    // taken from getBoundingClientRect(). Subsequent moves update the
    // same left / top deltas — the show / hide transition uses opacity
    // + translateY only, so there's no transform conflict.
    this._dragState = null;
    this._wireDrag();
  }

  _wireDrag() {
    const card = this.el;
    card.addEventListener("pointerdown", (e) => {
      // Bail out for any interactive descendant — close button, fact
      // tiles, future buttons. Tag the drag-allowed surfaces by NOT
      // putting `data-act` / `<button>` on them.
      if (e.target.closest('[data-act], button, a, input, select, textarea')) {
        return;
      }
      // Don't start drag on a tile tap (treat as a future "click" affordance).
      if (e.target.closest('.ua-tile')) return;

      const rect = card.getBoundingClientRect();
      this._dragState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        baseLeft: rect.left,
        baseTop:  rect.top,
      };
      // Convert from right-anchored to left-anchored coordinate so the
      // drag deltas have a consistent reference frame.
      card.style.left  = `${rect.left}px`;
      card.style.top   = `${rect.top}px`;
      card.style.right = "auto";
      card.classList.add("dragging");
      try { card.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    card.addEventListener("pointermove", (e) => {
      const s = this._dragState;
      if (!s) return;
      const dx = e.clientX - s.startX;
      const dy = e.clientY - s.startY;
      // Clamp into the viewport so the card can't be dragged fully
      // off-screen and lost. 24-px slack on every edge keeps a grab
      // surface visible even at the corners.
      const margin = 24;
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      const maxLeft = window.innerWidth  - margin;
      const maxTop  = window.innerHeight - margin;
      const minLeft = margin - w;
      const minTop  = 0;
      card.style.left = `${Math.min(maxLeft, Math.max(minLeft, s.baseLeft + dx))}px`;
      card.style.top  = `${Math.min(maxTop,  Math.max(minTop,  s.baseTop  + dy))}px`;
    });
    const end = (e) => {
      if (!this._dragState) return;
      const id = this._dragState.pointerId;
      this._dragState = null;
      card.classList.remove("dragging");
      try { card.releasePointerCapture(id); } catch {}
    };
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", end);
  }

  // Show annotation for a layer key ("splat" | "quad" | "voxel").
  // Calling repeatedly while visible swaps the content and restarts the
  // auto-hide timer, so a fast toggle sequence reads cleanly.
  show(layerKey) {
    const a = ANNOTATIONS[layerKey];
    if (!a) return;
    this.el.querySelector('[data-k="eyebrow"]').textContent = a.eyebrow ?? "";
    this.el.querySelector('[data-k="title"]')  .textContent = a.title   ?? "";
    this.el.querySelector('[data-k="hero"]')   .textContent = a.hero    ?? "";
    this.el.querySelector('[data-k="intro"]')  .textContent = a.intro   ?? "";
    this.el.querySelector('[data-k="body"]')   .textContent = a.body    ?? "";
    const gridEl = this.el.querySelector('[data-k="facts"]');
    gridEl.innerHTML = (a.facts || []).map(f => `
      <div class="ua-tile">
        <div class="ua-tile-icon">${ICONS[f.icon] || ""}</div>
        <div class="ua-tile-k">${escapeHtml(f.k)}</div>
        <div class="ua-tile-v">${escapeHtml(f.v)}</div>
      </div>
    `).join("");
    this.el.removeAttribute("hidden");
    // Force reflow so the show transition picks up cleanly on rapid swaps.
    void this.el.offsetHeight;
    this.el.classList.add("show");
    this._clearTimer();
    this._timer = setTimeout(() => this.hide(), AUTO_HIDE_MS);
  }

  hide() {
    this.el.classList.remove("show");
    this._clearTimer();
    // Defer hidden attr so the fade-out transition has a frame to run.
    setTimeout(() => {
      if (!this.el.classList.contains("show")) this.el.setAttribute("hidden", "");
    }, 320);
  }

  _clearTimer() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }
}
