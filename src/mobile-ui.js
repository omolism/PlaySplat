// ---------------------------------------------------------------------------
// MobileUI — one-thumb friendly bottom-bar + slide-up sheet, plus asset
// short-tap toast / long-press detail sheet. Only mounted when body.touch
// is set (main.js does the gating).
//
// Layout summary:
//
//   ┌─────────────────────────────────┐
//   │  hamburger (existing)           │ ← #mobile-nav-btn (advanced / help)
//   │                                 │
//   │       3D viewport               │
//   │                                 │
//   │  [ sheet content slides up ]    │ ← #mobile-sheet (drag-handle, swipe-down)
//   ├─────────────────────────────────┤
//   │ [Tour][FX][ Studio ][Info][Share]│ ← #mobile-bottombar
//   └─────────────────────────────────┘
//
// Bar layout (portrait):
//   Tour    — viewpoint list + camera-movement controls (merged; was 2 tabs)
//   FX      — curated click effects + Open Studio Advanced
//   Studio  — 3DGS / USD layer toggles (the project's CORE showcase; placed
//             in the CENTER slot as a visually dominant "primary action"
//             pill — same idiom as Apple's centre-button for Wallet, etc.)
//   Info    — FPS / splats / pipeline / guide / credits
//   Share   — one-shot share action (no sheet)
//
// Studio replaces the old top-right floating "#mobile-studio-btn" pill —
// having one always-on showcase trigger in the middle of the bottom bar is
// more thumb-friendly and removes a competing UI element from the top.
// One sheet at a time; re-tapping the same toolbar button closes it.
// ---------------------------------------------------------------------------

import { renderCard as renderAssetCard } from "./asset-hover.js";
import { wireCompareFrame } from "./tech-spec.js";
import { haptic }    from "./haptic.js";
import { playSound } from "./sounds.js";
import { fitVimeoFrames } from "./vimeo-fit.js";

// Lucide-style line icons. Stroke 1.7 reads crisp at the rendered ~22 px.
const ICONS = {
  // Splat-cloud — five overlapping translucent discs, visually echoing
  // a Gaussian splat point cloud. More on-brand for the 3DGS / USD
  // showcase than the generic "layers" stack we had before.
  studio:`<svg viewBox="0 0 24 24" fill="currentColor">
            <circle cx="8"  cy="9"  r="2.7" opacity="0.88"/>
            <circle cx="14" cy="11" r="3.1" opacity="0.55"/>
            <circle cx="9"  cy="15" r="2.3" opacity="0.42"/>
            <circle cx="16" cy="16" r="1.9" opacity="0.72"/>
            <circle cx="6"  cy="13" r="1.5" opacity="0.32"/>
          </svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <line x1="6"  y1="6" x2="18" y2="18"/>
            <line x1="18" y1="6" x2="6"  y2="18"/>
          </svg>`,
  views: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M2.5 12C4.5 7.5 8 5.5 12 5.5s7.5 2 9.5 6.5c-2 4.5-5.5 6.5-9.5 6.5S4.5 16.5 2.5 12z"/>
          </svg>`,
  // Tour — two waypoint pins joined by an arc. Reads as "guided
  // path through the scene", which is exactly what the tab does:
  // jump-to viewpoint pins + run the authored camera fly-through.
  tour:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 16c2-6 6-10 9-10s5 3 5 7-4 5-7 5-5 1-7 2"/>
            <circle cx="5"  cy="16" r="1.8" fill="currentColor"/>
            <circle cx="19" cy="13" r="1.8" fill="currentColor"/>
            <circle cx="12" cy="9"  r="1.4" fill="currentColor"/>
          </svg>`,
  fx:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>
            <circle cx="12" cy="12" r="3.5"/>
          </svg>`,
  cam:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="6.5" width="14" height="11" rx="1.5"/>
            <path d="M17 10l4.5-2.5v9L17 14z"/>
          </svg>`,
  info:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9"/>
            <line x1="12" y1="11" x2="12" y2="16.5"/>
            <line x1="12" y1="7.6" x2="12" y2="7.6"/>
          </svg>`,
  share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3v12"/>
            <polyline points="8 7 12 3 16 7"/>
            <path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/>
          </svg>`,
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ----------------------------------------------------------------------
// BottomSheet — single shared slide-up panel. The toolbar (and asset
// long-press) swaps the body content. Drag-down on the handle pulls
// the sheet down to follow the finger; >80 px of pull closes it.
// ----------------------------------------------------------------------
class BottomSheet {
  constructor() {
    this.open       = false;
    this.activeKey  = null;
    this._dragStart = null;
    this._dragY     = 0;
    this._onDismiss = null;

    // No backdrop — the sheet intentionally leaves the splat
    // interactive behind/above it. The user can keep orbiting /
    // panning the scene while the sheet is open. Close via the ×
    // button, swipe-down on the handle, or re-tap of the active
    // bottom-bar tab. This is the standard iOS / Material 3
    // "non-modal sheet" pattern.

    this.el = document.createElement("aside");
    this.el.id = "mobile-sheet";
    this.el.setAttribute("role", "dialog");
    this.el.innerHTML = `
      <div class="ms-handle" data-grab aria-hidden="true"></div>
      <div class="ms-head">
        <span class="ms-title">—</span>
        <button class="ms-close" aria-label="Close">&times;</button>
      </div>
      <div class="ms-body"></div>
    `;
    document.body.appendChild(this.el);

    this.titleEl  = this.el.querySelector(".ms-title");
    this.bodyEl   = this.el.querySelector(".ms-body");
    this.handleEl = this.el.querySelector(".ms-handle");

    this.el.querySelector(".ms-close").addEventListener("click", () => this.close());

    // Drag-down dismissal. Capture pointer so we keep tracking even if
    // the finger leaves the handle's bounds.
    this.handleEl.addEventListener("pointerdown", (e) => {
      this._dragStart = e.clientY;
      this._dragY     = 0;
      this.handleEl.setPointerCapture(e.pointerId);
      this.el.classList.add("dragging");
    });
    this.handleEl.addEventListener("pointermove", (e) => {
      if (this._dragStart == null) return;
      this._dragY = Math.max(0, e.clientY - this._dragStart);
      // Landscape phone uses a left-anchored layout (translateX(0) when
      // open), not the centred translateX(-50%) of every other layout.
      // Bail on drag-to-dismiss there — the X button is the close
      // affordance, and overlaying a centred translateX during the
      // drag would visually jump the sheet across the screen. Portrait
      // / tablet keep the original finger-follow behaviour.
      const isLandscapePhone = matchMedia("(orientation: landscape) and (max-height: 520px)").matches;
      if (isLandscapePhone) return;
      this.el.style.transform = `translateX(-50%) translateY(${this._dragY}px)`;
    });
    const endDrag = () => {
      if (this._dragStart == null) return;
      this._dragStart = null;
      this.el.classList.remove("dragging");
      if (this._dragY > 80) {
        this.close();
      } else {
        this.el.style.transform = "";
      }
      this._dragY = 0;
    };
    this.handleEl.addEventListener("pointerup",     endDrag);
    this.handleEl.addEventListener("pointercancel", endDrag);
  }

  show(key, title, contentNode) {
    const wasOpen = this.open;
    this.activeKey = key;
    this.titleEl.textContent = title;

    if (wasOpen) {
      // Tab-switch crossfade — the sheet is already on-screen and the
      // user just tapped a different bottom-bar slot (Tour → Effects →
      // Info). Hard-swapping innerHTML reads as "panel cleared then
      // refilled". Adding `.swapping` triggers a 130 ms opacity fade
      // on `.ms-body`, we swap the content at the trough, then remove
      // the class so the new content fades back up. End-to-end the
      // sheet reads as a single continuous surface that morphs between
      // tabs (Strategic analysis #8).
      this.bodyEl.classList.add("swapping");
      setTimeout(() => {
        this.bodyEl.replaceChildren(contentNode);
        this.bodyEl.classList.remove("swapping");
      }, 130);
    } else {
      this.bodyEl.replaceChildren(contentNode);
    }

    this.open = true;
    this.el.style.transform = "";
    this.el.classList.add("open");
  }

  close() {
    if (!this.open) return;
    this.open = false;
    const prevKey = this.activeKey;
    this.activeKey = null;
    this.el.classList.remove("open");
    this.el.style.transform = "";
    this._onDismiss?.(prevKey);
  }

  isOpen(key) { return this.open && (!key || this.activeKey === key); }
}

// ----------------------------------------------------------------------
// MobileStudioPanel — top-right floating Studio button + drop-down panel
// that hosts the 3DGS / USD layer controls (the *core* showcase surface
// of the project: toggle Splat ↔ Billboard ↔ Voxel rendering modes,
// swap each one's USD prototype subform, tweak sizes inline).
//
// We don't rebuild the controls — we re-parent the existing
// `#usd-layers-panel` DOM into our panel body so all its event handlers
// + internal state come along intact. On close we put it back where it
// came from (inside lil-gui's children container) so the Effects →
// "Open Advanced" path that moves the whole lil-gui still works.
// ----------------------------------------------------------------------
class MobileStudioPanel {
  constructor(usdLayersEl) {
    this.usdLayersEl    = usdLayersEl ?? null;
    this.originalParent = usdLayersEl?.parentNode ?? null;
    // Capture the sibling AFTER usd-layers-panel inside its parent so
    // we can put it back in the same slot on close — not at the end.
    // Without this, an appendChild() on close would push the panel to
    // the bottom of lil-gui (after Customize / Cinematic FX / Tech Spec /
    // Camera Movement), even though it was authored to live at the top.
    this.originalNextSibling = usdLayersEl?.nextSibling ?? null;
    this.open           = false;
    // Optional callback fired AFTER close() runs. MobileUI uses this to
    // clear the bottom-bar's "studio" tab highlight when the panel is
    // dismissed via × or outside-tap (not just via the bar button).
    this._onClose       = null;

    // Trigger button — top-right, same coordinate the hamburger used.
    this.btn = document.createElement("button");
    this.btn.id = "mobile-studio-btn";
    this.btn.setAttribute("aria-label", "3DGS / USD studio");
    this.btn.setAttribute("aria-expanded", "false");
    this.btn.innerHTML = ICONS.studio;
    this.btn.addEventListener("click", () => this.toggle());
    document.body.appendChild(this.btn);

    // Drop-down panel — anchored under the button, slides down from
    // top-right on open. No backdrop: the panel intentionally leaves
    // the rest of the scene interactive so the user can see the
    // splat update live as they flip Splat/Billboard/Voxel.
    this.panel = document.createElement("aside");
    this.panel.id = "mobile-studio-panel";
    this.panel.setAttribute("hidden", "");
    this.panel.setAttribute("role", "dialog");
    // No msp-sub here: the inner UsdLayers panel that gets re-parented
    // into msp-body has its own "Toggle layers · stack freely" hint, so a
    // second eyebrow line above would stack two near-identical strings
    // ("TOGGLE LAYERS · SWAP SUBFORMS" / "TOGGLE LAYERS · STACK FREELY")
    // — visible on landscape phone screenshots as the obvious redundancy.
    this.panel.innerHTML = `
      <header class="msp-head">
        <div class="msp-titles">
          <div class="msp-title">3DGS / USD</div>
        </div>
        <button class="msp-close" aria-label="Close">${ICONS.close}</button>
      </header>
      <div class="msp-body"></div>
    `;
    document.body.appendChild(this.panel);
    this.bodyEl = this.panel.querySelector(".msp-body");
    this.panel.querySelector(".msp-close").addEventListener("click", () => this.close());

    // Outside-tap dismissal. Capture phase so we run before the
    // tapped element's own pointerdown handler can dispatch anything.
    document.addEventListener("pointerdown", (e) => {
      if (!this.open) return;
      const t = e.target;
      if (this.panel.contains(t) || this.btn.contains(t)) return;
      this.close();
    }, true);
  }

  toggle() { this.open ? this.close() : this._show(); }

  _show() {
    if (!this.usdLayersEl) return;
    this.open = true;
    // Move the LIVE panel DOM into our body so existing event listeners
    // + reactive state keep working. The panel was originally mounted
    // inside lil-gui's `.children`; that lil-gui is CSS-hidden on touch,
    // so the panel itself isn't visible anywhere right now.
    this.bodyEl.appendChild(this.usdLayersEl);
    this.panel.removeAttribute("hidden");
    // Force reflow so the .open transition actually animates rather
    // than jumping straight to the final state.
    void this.panel.offsetHeight;
    this.panel.classList.add("open");
    this.btn.setAttribute("aria-expanded", "true");
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.panel.classList.remove("open");
    this.btn.setAttribute("aria-expanded", "false");
    // Restore the panel to its original parent IMMEDIATELY so any
    // subsequent UI that expects it there (Effects → Open Advanced
    // moves the entire lil-gui, including this panel) sees it in the
    // right place. insertBefore with the captured originalNextSibling
    // keeps the panel's authored slot (top of the lil-gui children
    // list) instead of pushing it to the bottom.
    if (this.originalParent && this.usdLayersEl) {
      this.originalParent.insertBefore(this.usdLayersEl, this.originalNextSibling);
    }
    setTimeout(() => {
      if (this.open) return;
      this.panel.setAttribute("hidden", "");
    }, 240);
    // Fire AFTER the panel is in its closed state so listeners (like the
    // bottom-bar active-tab clear) see consistent open=false.
    this._onClose?.();
  }
}

// ----------------------------------------------------------------------
// MobileUI — main entry point. Wires the toolbar to the sheet, builds
// each section lazily so its DOM reflects current state at open time.
// ----------------------------------------------------------------------
export class MobileUI {
  /**
   * @param {object} refs
   * @param {AnnotationManager} refs.annotations
   * @param {*}      refs.gui            — lil-gui root
   * @param {object} refs.effectParams   — { effect, ... } from effects.js
   * @param {*}      refs.effects        — EffectController instance
   * @param {*}      refs.postfx         — setupPostFX return
   * @param {*}      refs.assetHover     — AssetHoverManager (for short-tap / long-press)
   */
  constructor(refs) {
    this.refs = refs;
    this.sheet = new BottomSheet();
    // The Studio panel is the project's "core showcase" surface on
    // mobile — toggling 3DGS layers + their USD subform is the most
    // visually-striking interaction in the app. The panel itself stays
    // a top-anchored slide-down drop-down (re-parents the live
    // #usd-layers-panel so its state + listeners survive), but the
    // ENTRYPOINT moved from a separate top-right floating button into
    // the CENTRE slot of the bottom bar. One canonical affordance,
    // thumb-friendly, no top-right competition with the tab strip.
    if (refs.usdLayers?.el) {
      this.studio = new MobileStudioPanel(refs.usdLayers.el);
    }
    this._buildBar();
    this._buildContents();
    this._wireAssetTouch();
  }

  _buildBar() {
    this.bar = document.createElement("nav");
    this.bar.id = "mobile-bottombar";
    this.bar.setAttribute("aria-label", "Main");
    // 5-slot layout — `studio` sits in the centre as a visually dominant
    // "primary action" pill (mb-center class scales the icon + adds a
    // subtle ring). Tour (slot 1) merges the old Views + Camera tabs:
    // viewpoint list above, camera-movement controls below.
    this.bar.innerHTML = `
      <button data-tab="tour"   aria-label="Tour"        ><span class="mb-ico">${ICONS.tour  }</span><span class="mb-lbl">Tour</span></button>
      <button data-tab="fx"     aria-label="Effects"     ><span class="mb-ico">${ICONS.fx    }</span><span class="mb-lbl">Effects</span></button>
      <button data-tab="studio" aria-label="3DGS Studio" class="mb-center"><span class="mb-ico">${ICONS.studio}</span><span class="mb-lbl">Studio</span></button>
      <button data-tab="info"   aria-label="Info"        ><span class="mb-ico">${ICONS.info  }</span><span class="mb-lbl">Info</span></button>
      <button data-tab="share"  aria-label="Share"       ><span class="mb-ico">${ICONS.share }</span><span class="mb-lbl">Share</span></button>
    `;
    document.body.appendChild(this.bar);

    this.bar.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-tab]");
      if (!btn) return;
      const tab = btn.dataset.tab;

      // Share is a one-shot action (no sheet).
      if (tab === "share") { this._doShare(); return; }

      // Studio opens the existing MobileStudioPanel (top-anchored slide-
      // down hosting #usd-layers-panel) instead of the bottom sheet, so
      // the live USD layer DOM with all its event handlers + reactive
      // state comes along untouched. Close any open bottom sheet first
      // so the Studio panel isn't visually layered on top of it.
      if (tab === "studio") {
        if (!this.studio) return;
        if (this.studio.open) {
          this.studio.close();
          this._setActive(null);
        } else {
          if (this.sheet.open) this.sheet.close();
          // Micro-feedback for the "panel rises" event — short tactile
          // pulse + the rise sound's 140 ms upward sweep. Reads as
          // "container opened" rather than "button pressed". Same
          // treatment applies to the Tour / Effects / Info sheets below
          // so all four primary tabs share one open-sound vocabulary.
          haptic(6);
          playSound("rise");
          this.studio._show();
          this._setActive("studio");
        }
        return;
      }

      // Re-tapping the active tab closes the sheet (toggle behaviour).
      if (this.sheet.isOpen(tab)) {
        this.sheet.close();
        this._setActive(null);
        return;
      }
      const built = this._sections[tab]();
      haptic(6);
      playSound("rise");
      this.sheet.show(tab, built.title, built.node);
      this._setActive(tab);
    });

    // Keep the bottom-bar's active-tab highlight in sync with sheet state.
    this.sheet._onDismiss = () => this._setActive(null);
    // Same for the Studio panel — when the user dismisses it via × or
    // outside-tap, clear the "studio" active highlight.
    if (this.studio) {
      this.studio._onClose = () => {
        if (this._activeTab === "studio") this._setActive(null);
      };
    }
  }

  _setActive(tab) {
    this._activeTab = tab;
    this.bar.querySelectorAll("button[data-tab]").forEach(b => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
  }

  _buildContents() {
    // Lazy factories — each invocation rebuilds the DOM so toggles
    // reflect current state (e.g. active viewpoint, postfx.enabled).
    // `tour` = old views + cam merged into one sheet (jump-to viewpoints
    // above, camera-movement controls below). The old `views` and `cam`
    // entries are gone — Studio occupies the centre slot now and has its
    // own panel (no sheet).
    this._sections = {
      tour:  () => ({ title: "Tour",        node: this._tourContent() }),
      fx:    () => ({ title: "Effects",     node: this._fxContent()   }),
      info:  () => ({ title: "Scene Info",  node: this._infoContent() }),
    };
  }

  // ---- Tour (Viewpoints + Camera-movement merged) ---------------------
  // Why merged: on a phone, "jump to viewpoint" and "play the fly-
  // through" are the SAME mental model — getting around the scene
  // without manually dragging. Splitting them across two tabs forced
  // users to think about implementation details (preset vs animation).
  // Combining them into one Tour sheet (Viewpoints list on top, camera
  // controls below) makes the affordance feel like a single feature.
  _tourContent() {
    const wrap = document.createElement("div");
    wrap.className = "ms-tour";

    // -- Viewpoints section --
    const annotations = this.refs.annotations;
    const hasViewpoints = annotations && annotations.viewpoints.length > 0;
    wrap.appendChild(this._row("Viewpoints"));
    if (hasViewpoints) {
      const list = document.createElement("ul");
      list.className = "ms-views-list";
      annotations.viewpoints.forEach((vp, i) => {
        const li = document.createElement("li");
        const isActive = annotations.activeId === vp.id;
        if (isActive) li.classList.add("active");
        li.innerHTML = `
          <span class="ms-vp-num">${i + 1}</span>
          <span class="ms-vp-name">${escapeHtml(vp.name)}</span>
          ${isActive ? `<span class="ms-vp-badge">Active</span>` : ""}
        `;
        li.addEventListener("click", () => {
          annotations.flyTo(vp.id);
          this.sheet.close();
        });
        list.appendChild(li);
      });
      wrap.appendChild(list);
    } else {
      const empty = document.createElement("div");
      empty.className = "ms-empty";
      empty.textContent = "No viewpoints yet.";
      wrap.appendChild(empty);
    }

    // -- Camera Movement section --
    // Per user request: drop the "Stop & reset" button. Play / Pause +
    // Replay cover the actual mobile journeys (start watching, pause if
    // distracted, start again from the top). "Stop & reset" was a
    // duplicate of Replay's first half — replay both stops AND resets
    // since the cinematic loops back to its opening pose. Removing it
    // also tightens the Tour sheet by one row, matching the AR-style
    // "as few controls as possible" direction the rest of the mobile
    // UI is heading.
    wrap.appendChild(this._row("Camera Movement"));
    const cam = document.createElement("div");
    cam.className = "ms-cam";
    cam.innerHTML = `
      <button class="ms-action" data-act="play">
        <span class="ms-icon-glyph">▶</span> Play / Pause
      </button>
      <button class="ms-action" data-act="replay">
        <span class="ms-icon-glyph">↻</span> Replay intro
      </button>
      <div class="ms-help">Plays the authored fly-through. Replay starts over from the opening pose.</div>
    `;
    // Play / Pause used to carry .ms-action-primary (white-filled pill)
    // because it was the headline action when Stop also existed. With Stop
    // removed and only two equally-weighted choices left, the bright fill
    // made it read as "this is THE button" rather than "this is one of two
    // options". User flagged it: "这个 play 不需要高亮". Both buttons now
    // share the subtle .ms-action treatment.
    cam.querySelector('[data-act="play"]'  ).addEventListener("click", () => window.__camMovePlayPause?.());
    cam.querySelector('[data-act="replay"]').addEventListener("click", () => window.__replayIntro?.());
    wrap.appendChild(cam);

    return wrap;
  }

  // ---- Effects (curated) ---------------------------------------------
  _fxContent() {
    const wrap = document.createElement("div");
    wrap.className = "ms-fx";
    const { effectParams, postfx, gui } = this.refs;

    // Click-effect chips. Keeps the most visually-distinct subset; the
    // others stay reachable through Advanced.
    const EFFECTS = [
      "Wave & Tint", "Dissolve & Reform", "Scan Line",
      "Spiral Smear", "Vortex Drift", "Slime Molds", "Feather Roots",
    ];
    wrap.appendChild(this._row("Click effect"));
    const chips = document.createElement("div");
    chips.className = "ms-chips";
    // Resolve the lil-gui "Effect" controller once so the chips can drive
    // it via setValue() — that path fires onChange (controller.applyParams)
    // exactly the way the desktop dropdown does, instead of bypassing the
    // gui's internal state and getting it out of sync.
    const effectCtrl = gui?.controllersRecursive?.()?.find(c => c._name === "Effect");
    for (const name of EFFECTS) {
      const chip = document.createElement("button");
      chip.className = "ms-chip" + (effectParams.effect === name ? " on" : "");
      chip.textContent = name;
      chip.addEventListener("click", () => {
        if (effectCtrl) effectCtrl.setValue(name);
        else            effectParams.effect = name;
        chips.querySelectorAll(".ms-chip").forEach(c =>
          c.classList.toggle("on", c.textContent === name));
      });
      chips.appendChild(chip);
    }
    wrap.appendChild(chips);

    // Post-process master toggle — wraps the Post-Process › Enable
    // controller on the lil-gui side. setValue() fires the onChange
    // chain so every pass's enabled-state gets re-evaluated.
    const postCtrl = gui?.controllersRecursive?.()?.find(c =>
      c._name === "Enable" && c.object === postfx?.params);
    if (postCtrl) {
      wrap.appendChild(this._toggleRow("Post-process FX", !!postfx.params.postEnable, (next) => {
        postCtrl.setValue(next);
      }));
    }

    // HDR sky toggle, if window.__hdrParams was exposed (it isn't always
    // — depends on whether the user opened the HDR folder before).
    // Skipped silently when not available.

    // Advanced — pin the full lil-gui into the sheet so all 80+ controls
    // are reachable for power users. On dismiss we restore the gui to
    // its previous DOM position (top-right) so desktop callers don't get
    // surprised after an HMR.
    const adv = document.createElement("button");
    adv.className = "ms-action ms-advanced";
    adv.innerHTML = `<span>Open Studio · Advanced</span><span class="ms-arrow">›</span>`;
    adv.addEventListener("click", () => this._openAdvanced());
    wrap.appendChild(adv);

    return wrap;
  }

  _openAdvanced() {
    const { gui } = this.refs;
    if (!gui) return;
    const guiEl = gui.domElement;
    const oldParent = guiEl.parentNode;
    const oldStyle = {
      top:        guiEl.style.top,
      right:      guiEl.style.right,
      maxHeight:  guiEl.style.maxHeight,
      position:   guiEl.style.position,
      width:      guiEl.style.width,
    };
    const sheetWrap = document.createElement("div");
    sheetWrap.className = "ms-gui-wrap";
    sheetWrap.appendChild(guiEl);
    guiEl.style.position  = "static";
    guiEl.style.top       = "";
    guiEl.style.right     = "";
    guiEl.style.maxHeight = "";
    guiEl.style.width     = "100%";
    gui.open();
    this.sheet.show("advanced", "Studio · Advanced", sheetWrap);
    this._setActive("fx");

    // Restore on dismiss. Note: chains with whatever onDismiss was set
    // previously so the toolbar's active-tab clear still runs.
    const prev = this.sheet._onDismiss;
    this.sheet._onDismiss = (key) => {
      guiEl.style.position  = oldStyle.position;
      guiEl.style.top       = oldStyle.top;
      guiEl.style.right     = oldStyle.right;
      guiEl.style.maxHeight = oldStyle.maxHeight;
      guiEl.style.width     = oldStyle.width;
      oldParent?.appendChild(guiEl);
      gui.close();
      this.sheet._onDismiss = prev;
      prev?.(key);
    };
  }

  // (Old _camContent() removed — Camera-movement controls now live
  //  inside _tourContent() so users find them next to the Viewpoints
  //  list. See the "tour" tab in _buildBar/_buildContents.)

  // ---- Info -----------------------------------------------------------
  _infoContent() {
    const wrap = document.createElement("div");
    wrap.className = "ms-info";
    const splatCount = (window.__hudRefs?.splat?.packedSplats?.numSplats)
                    || (this.refs.splat?.packedSplats?.numSplats)
                    || 0;
    const fps = Math.round(this._lastFps ?? 0);
    wrap.innerHTML = `
      <div class="ms-info-grid">
        <div class="ms-info-k">FPS</div>
        <div class="ms-info-v">${fps || "…"}</div>
        <div class="ms-info-k">Splats</div>
        <div class="ms-info-v">${splatCount.toLocaleString()}</div>
        <div class="ms-info-k">Renderer</div>
        <div class="ms-info-v">Spark · Three.js · WebGL 2</div>
        <div class="ms-info-k">Scene</div>
        <div class="ms-info-v">SplatGarden</div>
      </div>
      <button class="ms-action" data-act="pipeline">Open Tech Breakdown</button>
      <button class="ms-action" data-act="guide">Open Quick Guide</button>
      <button class="ms-action" data-act="credits">Credits</button>
    `;
    // Pipeline = the tech-spec asset drawer. Moved here from the (now-
    // empty) hamburger so users on touch still have a way in. Closes
    // the sheet first so the drawer slide-in isn't covered by it.
    wrap.querySelector('[data-act="pipeline"]').addEventListener("click", () => {
      this.sheet.close();
      window.__techSpec?.toggle?.();
    });
    wrap.querySelector('[data-act="guide"]').addEventListener("click", () => {
      this.sheet.close();
      window.__keyHints?.showFor?.(6500);
    });
    wrap.querySelector('[data-act="credits"]').addEventListener("click", () => {
      this.sheet.close();
      window.__credits?.toggle?.();
    });
    return wrap;
  }

  // Called by main.js's per-frame loop so the Info sheet (when open)
  // can show a live-ish FPS reading. Cheap: just stores the dt.
  tickFps(dt) {
    if (!dt || dt <= 0) return;
    const inst = 1 / dt;
    // EMA so the readout doesn't flicker every frame.
    this._lastFps = this._lastFps == null ? inst : this._lastFps * 0.9 + inst * 0.1;
  }

  // ---- Share ----------------------------------------------------------
  async _doShare() {
    const url   = location.href;
    const title = document.title || "SplatGarden Studio";
    if (navigator.share) {
      try { await navigator.share({ url, title }); return; } catch { /* user cancelled */ }
    }
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(url);
        this._toast("Link copied");
        return;
      } catch {}
    }
    this._toast("Tap-and-hold the URL bar to share");
  }

  // ---- Asset tap → detail sheet --------------------------------------
  // Every tap on a 3D hotspot opens the full asset card in a bottom
  // sheet (same content the desktop hover card shows). Originally I
  // gated this behind a 480 ms long-press to keep short-taps light, but
  // long-press is undiscoverable on mobile — users tapped, nothing
  // visible happened, and the asset card was effectively missing on
  // touch. Tap-to-reveal is the conventional pattern and matches what
  // the desktop click already does (fly + show card).
  _wireAssetTouch() {
    const ah = this.refs.assetHover;
    if (!ah) return;
    const openAssetSheet = (it) => {
      const node = document.createElement("div");
      // .ah-card is the shared "content styling" class — see
      // asset-hover.js for the matching className on the floating
      // desktop card. With both wrappers carrying it, the rich
      // card content (toolchain chips, embed video, before/after,
      // triptych, etc.) renders identically on phone and desktop.
      // .ms-asset-card is kept for the few sheet-specific overrides
      // (hide the redundant × button, tighten the header margin).
      node.className = "ah-card ms-asset-card";
      node.innerHTML = renderAssetCard(it);
      // The card's own × button uses data-act="close"; route it to the
      // sheet's close so users get one consistent dismiss path.
      node.querySelector('[data-act="close"]')?.addEventListener("click", () => this.sheet.close());
      this.sheet.show("asset", it.name, node);
      // Wire any A/B compare slider that landed in the rendered markup.
      // This was previously only happening on the desktop floating
      // .ah-card path (asset-hover.js _show) and the Tech Breakdown
      // drawer (tech-spec.js openOverlay) — the mobile-sheet rendering
      // was a third entry point that loaded the same markup but never
      // attached the pointerdown handlers, so on phones the slider
      // looked correct but stayed frozen at 50%. Calling
      // wireCompareFrame here closes that gap; the function itself is
      // idempotent (data-cmpWired guard) so repeat opens are safe.
      node.querySelectorAll(".ts-compare .cmp-frame").forEach(wireCompareFrame);
      // Auto-fit any Vimeo iframes to their clip's actual ratio so
      // there are no letterbox bars inside the bottom-sheet card.
      // Must run AFTER the sheet attaches the node — the iframe needs
      // to be in the live DOM before the Vimeo Player API can measure
      // it.
      fitVimeoFrames(node);
      this._setActive(null);
    };
    // Short tap AND long press open the same sheet. The long-press
    // path stays wired in asset-hover.js as a backup gesture — if a
    // user holds rather than taps, they still get the card.
    ah.onAssetShortTap  = openAssetSheet;
    ah.onAssetLongPress = openAssetSheet;
  }

  // ---- Toast helper ---------------------------------------------------
  _toast(msg, durationMs = 2200) {
    let t = document.getElementById("mobile-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "mobile-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove("show"), durationMs);
  }

  // ---- DOM-builder helpers -------------------------------------------
  _row(label) {
    const d = document.createElement("div");
    d.className = "ms-row-label";
    d.textContent = label;
    return d;
  }
  _toggleRow(label, initialOn, onChange) {
    const d = document.createElement("div");
    d.className = "ms-toggle-row";
    d.innerHTML = `
      <span class="ms-toggle-label">${escapeHtml(label)}</span>
      <button class="ms-switch ${initialOn ? "on" : ""}" aria-pressed="${initialOn}">
        <span class="ms-switch-knob"></span>
      </button>
    `;
    const btn = d.querySelector(".ms-switch");
    btn.addEventListener("click", () => {
      const next = !btn.classList.contains("on");
      btn.classList.toggle("on", next);
      btn.setAttribute("aria-pressed", String(next));
      onChange(next);
    });
    return d;
  }
}
