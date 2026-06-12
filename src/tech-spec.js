// ---------------------------------------------------------------------------
// Pipeline — right-side slide-in that doubles as the showcase's information-
// design centerpiece. Organised by ASSETS first, then the systems that
// produce / render / drive them. FX and Post-FX sit at the bottom as "toy"
// sections.
//
// Each item can carry the legacy { ref, note, source } trio or the richer
// asset-pipeline fields { toolchain[], output, location }. The renderer
// shows whichever ones are present.
//
// Toggle: press T, or via instance.toggle(). Sections are collapsible; the
// entire panel slides in from the right.
// ---------------------------------------------------------------------------

import { initTickers }    from "./ticker.js";
import { fitVimeoFrames } from "./vimeo-fit.js";
// The rich-block renderers live in asset-hover.js so the asset hover card
// and the Tech Breakdown drawer share one source of truth for processCards
// / keyPoints / embed markup. Circular import is safe here — both modules
// only call across the boundary at runtime (inside renderCard / renderItem),
// not at module-evaluation time. Keeping the helpers co-located with the
// hover card avoids a third "card-blocks" module just to break the cycle.
import {
  renderProcessCards,
  renderKeyPoints,
  renderEmbed,
  renderSimVideo,
  escapeHtml,
} from "./asset-hover.js";

// Same BASE_URL trick the splat / FBX / HDRI / colmap loaders use —
// resolves to "/" on local dev and "/PlaySplat/" on the
// GitHub Pages deploy. Without this prefix, the texture `<img src>`
// values would point at the domain root on production and 404 — the
// "images still aren't showing" symptom the user just flagged.
const BASE = import.meta.env.BASE_URL;

export const TECH_SPECS = [
  // ============== Observer-first ordering ==============
  // Mirrors the canonical 3-stage pipeline figure shipped on the web
  // intro page — Asset making → Scene assembly → 3DGS capture — but
  // presented BACKWARDS so the drawer leads with what the viewer is
  // actually looking at right now (the splat) and unwinds to the
  // upstream stages.
  //
  // Overview — one-screen anchor: what is this, in one sentence.
  // 01 3DGS  — what the viewer is actually LOOKING AT (rendering
  //            primitive + capture + training). Leads because observers
  //            ask "what is this?" before "how did the team build it?".
  // 02 Production — the per-asset authoring that produced the captured
  //            scene. The original 3-layer scheme (L1 R&D + L2
  //            Production + L3 3DGS) was retired when L1 dropped out;
  //            tooling notes (AI Texture Stylization, OpenUSD subforms)
  //            now live inside the per-asset cards that consume them,
  //            and the live USD showcase lives in the 3DGS/USD panel on
  //            screen. Each section's `pillarIdx` is its reading-order
  //            number after Overview — strictly presentational.
  {
    section:   "Overview",
    group:     "summary",
    desc:      "What you're looking at, in one screen.",
    items: [
      {
        name:      "PlaySplat",
        ref:       "Houdini × Unreal × SpeedTree · captured by a multi-cam rig · 3DGS-trained · rendered live in your browser",
        // Embedded `.ticker` spans roll their values from 0 → target the
        // first time the drawer opens (IntersectionObserver in
        // ticker.js fires the animation when each span scrolls into
        // view). Static text + commas remain literal so only the
        // numbers animate.
        output:    "≈ <span class=\"ticker\" data-target=\"3000000\" data-format=\"compact\">0</span> splats · <span class=\"ticker\" data-target=\"990\">0</span> capture frames · <span class=\"ticker\" data-target=\"16.67\" data-decimals=\"2\">0</span>s authored flythrough",
        note:      "An Unreal-authored garden, captured by a multi-camera rig, reconstructed with COLMAP, trained in parallel by Postshot and Lichtfeld Studio, optimized with Houdini GSOP, and rendered in real time via Spark on Three.js + WebGL — the breakdown below walks the pipeline backwards. It starts with the rendering primitive you're looking at right now, then unwinds to the per-asset authoring that produced the captured scene.",
      },
    ],
  },

  {
    section:   "3DGS",
    group:     "layer",
    // Sequential reading-order chip. Was `layerNum: 3` back when the
    // drawer carried three pipeline layers (L1 R&D + L2 Production +
    // L3 3DGS); with L1 retired the "L3" label implied a missing
    // anchor. The chip now reads "01" because 3DGS is the first
    // detail section after Overview — what the viewer is actually
    // looking at.
    pillarIdx: 1,
    desc:      "Capturing the dressed Unreal scene and training it as a 3D Gaussian Splat. Postshot and Lichtfeld Studio run in parallel as two independent trainers, and we cross-compare their results to pick the cleaner one.",
    toolchain: ["Multi-camera rig", "COLMAP", "Postshot", "Lichtfeld Studio", "Spark"],
    items: [
      {
        name: "3D Gaussian Splatting",
        ref:  "Kerbl et al., SIGGRAPH 2023 · rendered in-browser via @sparkjsdev/spark",
        note: "The render primitive: per-splat ellipsoidal Gaussians + spherical-harmonic view-dependent color. The composed garden ends up as a single .splat asset, rasterized in real time by Spark on Three.js + WebGL 2.",
      },
      // Upstream stages that turn the dressed Unreal scene into a
      // trainable input plus the post-training cleanup. The training
      // step itself is intentionally NOT a keyPoint here because the
      // Artistic 3DGS card below carries that beat visually (Postshot
      // screenshots covering raw radiance field → cleanup → camera
      // trajectory) and a text bullet would duplicate the story.
      // Originally lived as four separate single-paragraph items
      // (Capture, Pose reconstruction, Splat training parallel, Splat
      // optimization) that ate vertical real estate before the reader
      // could reach Artistic 3DGS; consolidated here so the section
      // reads as a clean three-item list.
      {
        name:      "Capture and reconstruction pipeline",
        ref:       "Multi-camera capture · COLMAP poses · Houdini GSOP cleanup",
        toolchain: ["Multi-camera rig", "COLMAP", "Houdini GSOP"],
        output:    "Optimized 3DGS · ≈ 3M splats · ships as public/PlaySplat_PC.splat",
        note:      "How the dressed Unreal scene becomes the splat you're looking at: photographed at the multi-camera rig, solved into 990 camera poses by COLMAP, then (after training, which the Artistic 3DGS card walks through) decimated by Houdini's Gaussian Splat Operators to fit a real-time budget.",
        keyPoints: [
          { key: "Capture",             value: "The whole Unreal scene is photographed at a multi-camera array; every frame feeds the downstream pose solver and trainers." },
          { key: "Pose reconstruction", value: "COLMAP solves intrinsics and extrinsics for every capture frame; the resulting 990 camera poses feed both trainers and double as the Training Cameras overlay in Tech Spec." },
          { key: "Optimization",        value: "After training, Houdini's GSOP (Gaussian Splat Operators) toolset prunes outlier splats and merges redundant low-opacity points, bringing the count down to about 3M without a visible quality loss." },
        ],
        source:    "src/colmap-loader.js:50",
      },
      {
        // Deployment story — bridges the trainer output (Postshot's
        // raw Gaussian field) to what actually ships in the browser.
        // Same pipeline originally targeted Unreal Engine 5 (see the
        // SIGGRAPH 2026 poster "Deploying World Models in Real Time:
        // Artistic 3DGS via USD Voxelization"); this web viewer is
        // the browser port. Two processCards: 01 walks the training
        // stages visually (the three Postshot screenshots cover the
        // raw initialization → cleanup → residual sparse point
        // cloud); 02 shows the USD-voxel + point-cloud composite
        // that the 3DGS/USD panel re-exposes as live layers.
        name:      "Artistic 3DGS · USD voxelization",
        ref:       "Postshot training → USD voxel + point-cloud overlay → real-time deployment",
        toolchain: ["Postshot", "USD PointInstancer", "LiDAR Point Cloud", "Spark · web playback"],
        output:    "Real-time 3DGS with USD-deployable structure + atmosphere layers",
        note:      "The trained splat is the seed for an artistic deployment pipeline. Postshot's cleanup brings a chaotic initial radiance field down to a usable Gaussian field; USD voxelization then composites the cleaned splat with a complementary point-cloud overlay so collision-bearing voxels carry structure while transparent points carry atmospheric scatter. The same dual-layer system originally targeted Unreal Engine 5 — this browser viewer is the web port of the same approach, with the voxel and point-cloud surfaces re-exposed in the 3DGS / USD panel.",
        processCards: [
          {
            eyebrow:     "01 · TRAINING",
            description: "Postshot's optimizer starts from a chaotic radiance-field initialization and progressively shapes the Gaussian field against the 990 COLMAP-recovered camera poses. The cleanup pass prunes outlier splats so the dense Gaussian field reads cleanly; the third frame overlays the camera trajectory recovered by COLMAP, the spatial scaffold Postshot uses to anchor every optimization step.",
            rows: [
              { layout: "pair", aspectRatio: "16 / 9", items: [
                { src: `${BASE}textures/3dgs/3dgs-before-cleanup.webp`, caption: "Before Cleanup" },
                { src: `${BASE}textures/3dgs/3dgs-after-cleanup.webp`,  caption: "After Cleanup" },
              ]},
              { layout: "single", items: [
                { src: `${BASE}textures/3dgs/3dgs-pointcloud.webp`, caption: "Camera trajectory" },
              ]},
            ],
          },
          {
            eyebrow:     "02 · DEPLOYMENT",
            description: "USD voxelization composites the trained splat with a complementary point-cloud overlay. The voxel layer (USD PointInstancer) carries solid structure for collision and geometry; the point-cloud layer adds atmospheric scatter and a stylized skybox feel. Both surfaces are toggleable in the 3DGS / USD panel of this viewer.",
            rows: [
              { layout: "single", items: [
                { src: `${BASE}textures/3dgs/3dgs-pointcloud-overlay.webp`, caption: "PointCloud Overlay on 3DGS" },
              ]},
            ],
          },
        ],
      },
    ],
  },

];

function renderItem(it, visMap) {
  const isAsset = Array.isArray(it.toolchain) && it.toolchain.length > 0;
  // Only assets with a worldPos have a hotspot in the scene, so only those
  // get the ON/OFF toggle. Default visibility is ON unless the user has
  // toggled it OFF (state persisted in localStorage by the TechSpec class).
  const hasHotspot = Array.isArray(it.worldPos);
  const on = !visMap || visMap.get(it.name) !== false;
  const toggle = hasHotspot
    ? `<button class="ts-hotspot-toggle" data-act="toggle-hotspot"
         data-asset-name="${it.name}" data-on="${on ? "1" : "0"}"
         title="Show / hide ${it.name} hotspot in the scene"
         aria-pressed="${on ? "true" : "false"}">
         <span class="ts-toggle-dot"></span>
         <span class="ts-toggle-label">${on ? "ON" : "OFF"}</span>
       </button>`
    : "";

  // 1. Title row — big asset name + optional location chip + hotspot toggle.
  // Asset items (those with a toolchain) get a folding accordion so the
  // long Production list reads as a scannable index of asset names; the
  // reader clicks a title to expand its full card. Non-asset items
  // (Overview pillars, the short L3 prose entries) are short enough that
  // hiding them adds friction without saving scroll, so they stay open.
  // The caret + role="button" + tabindex + aria-expanded markup live
  // ONLY on asset items; the click handler in TechSpec ignores
  // anything else, and the hotspot toggle inside the head already
  // stopPropagation()s so it doesn't accidentally fold the card.
  const head = isAsset
    ? `<header class="ts-item-head"
              role="button"
              tabindex="0"
              aria-expanded="false"
              title="Click to expand">
         <h3 class="ts-item-name">${it.name}</h3>
         ${it.location ? `<span class="ts-item-loc">${it.location}</span>` : ""}
         ${toggle}
         <span class="ts-item-caret" aria-hidden="true">▾</span>
       </header>`
    : `<header class="ts-item-head">
         <h3 class="ts-item-name">${it.name}</h3>
         ${it.location ? `<span class="ts-item-loc">${it.location}</span>` : ""}
         ${toggle}
       </header>`;

  // 2. Sub-line — short technical tagline (ref). Sits right under the title.
  const sub = it.ref ? `<div class="ts-item-sub">${it.ref}</div>` : "";

  // 3. Keywords zone — chip row. No ▸ separators (the label is "Keywords"
  // now, not "Toolchain" — arrows implied directional pipeline flow
  // which doesn't apply to a tag list). Chips space themselves via
  // the .ts-chain flex-gap rule.
  let chain = "";
  if (isAsset) {
    const chips = it.toolchain
      .map(t => `<span class="ts-chip">${t}</span>`)
      .join("");
    chain = `<div class="ts-zone">
        <div class="ts-zone-label">Keywords</div>
        <div class="ts-chain">${chips}</div>
      </div>`;
  }

  // 4. Output zone — explicit "OUTPUT" label + value
  const output = it.output ? `<div class="ts-zone">
        <div class="ts-zone-label">Output</div>
        <div class="ts-zone-val">${it.output}</div>
      </div>` : "";

  // 5. Note — the readable prose paragraph
  const note = it.note ? `<p class="ts-item-note">${it.note}</p>` : "";

  // 5b. Before/after compare widget — drag the handle to wipe between the
  // pre-AI texture and the stylized output. Used by AI Stylization items;
  // declared via `compare: { before, after, labelA, labelB }` on the item.
  const compare = it.compare ? renderCompare(it.compare) : "";

  // 5c. Rich content blocks (processCards / keyPoints / embed / simVideo) —
  // mirrors the asset hover card so the Tech Breakdown drawer shows the
  // same step-style walkthroughs, A/B compare grids, and Vimeo embeds.
  // Shared with renderCard via the helpers exported from asset-hover.js.
  // Wrapped in `.ts-rich` so the CSS rules that originally scope to
  // `.ah-card` can also scope to the drawer via `:is(.ah-card, .ts-rich)`.
  const hasRich = (Array.isArray(it.processCards) && it.processCards.length)
               || (Array.isArray(it.keyPoints)    && it.keyPoints.length)
               || it.embed
               || it.simVideo;
  const rich = hasRich
    ? `<div class="ts-rich">
         ${it.simVideo ? renderSimVideo(it.simVideo) : ""}
         ${Array.isArray(it.embed)
             ? it.embed.map(e => renderEmbed(e)).join("")
             : (it.embed ? renderEmbed(it.embed) : "")}
         ${renderProcessCards(it.processCards)}
         ${renderKeyPoints(it.keyPoints)}
       </div>`
    : "";

  // 6. Source — small mono footer with hairline rule above
  const source = it.source ? `<div class="ts-item-src">${it.source}</div>` : "";

  // Asset items wrap their body in `.ts-item-body` so the accordion toggle
  // has one hide target. They also start with `.collapsed` so the drawer
  // first reads as a clean list of asset titles, and the reader clicks
  // a title to expand its card. Non-asset items render the body inline
  // (no wrapper, no collapse) — they're short enough that folding adds
  // friction without saving scroll.
  const body = `${sub}${chain}${output}${note}${compare}${rich}${source}`;
  if (isAsset) {
    return `<li class="ts-item ts-item-asset collapsed">${head}<div class="ts-item-body">${body}</div></li>`;
  }
  return `<li class="ts-item">${head}${body}</li>`;
}

export function renderCompare(c) {
  const lblA = c.labelA || "Before";
  const lblB = c.labelB || "After";
  const layer = (url, fallback, cls) => url
    ? `<img class="cmp-img ${cls}" src="${url}" draggable="false" alt="">`
    : `<div class="cmp-img cmp-ph ${cls}"><span>${fallback}</span></div>`;
  // Labels render BELOW the frame as a citation-style row (left = A, right =
  // B). The previous design overlaid them as absolute-positioned tags inside
  // the frame, which worked when labels were short ("BEFORE" / "AFTER") but
  // collided in the middle once labels grew into full descriptions like
  // "Before: Procedural base" / "After: AI-stylized oil paint" — especially
  // in the side-by-side compare-grid layout inside the Tech Breakdown
  // drawer where each cell is only ~half the row width. Citations below
  // never overlap regardless of label length and read more like a
  // figure-caption: image first, then the legend.
  return `
    <div class="ts-compare">
      <div class="cmp-frame" data-cmp>
        ${layer(c.after, "AFTER · placeholder", "cmp-img-b")}
        ${layer(c.before, "BEFORE · placeholder", "cmp-img-a")}
        <div class="cmp-handle"><div class="cmp-knob"></div></div>
      </div>
      <div class="cmp-captions">
        <span class="cmp-cap cmp-cap-a">${lblA}</span>
        <span class="cmp-cap cmp-cap-b">${lblB}</span>
      </div>
    </div>`;
}

// Wire the drag-to-wipe interaction on a single compare frame.
//
// Listeners live on the FRAME for pointerdown (so the grab target is the
// whole frame area, not just the 2 px handle) and on DOCUMENT for the
// follow-up pointermove / pointerup / pointercancel. The document-level
// follow-up matters specifically on iOS Safari when the compare frame
// sits inside an overflow:auto parent — which the asset hover card is
// (#asset-hover-card { overflow-y: auto }). In that arrangement
// setPointerCapture on the frame silently fails to keep tracking once
// the finger leaves the frame's bounding box (small compare frames are
// only a few hundred px wide on phone), so pointermove events stop
// arriving on the frame and the slider stays stuck at the initial tap
// position. Routing the follow-up through document.addEventListener
// removes the capture-on-frame dependency entirely.
//
// Also: an explicit touchstart with `{ passive: false }` calling
// preventDefault belt-and-suspenders against iOS's gesture-commit
// heuristic. CSS already declares `touch-action: none` on .cmp-frame,
// but in scrollable parents iOS will sometimes commit a pan gesture in
// the first few pixels of movement before the pointerdown handler
// runs; the explicit touchstart preventDefault closes that window.
export function wireCompareFrame(frame) {
  // Idempotent — _show() re-runs this every time the card rebuilds, so
  // bail if we've already wired this frame.
  if (frame.dataset.cmpWired === "1") return;
  frame.dataset.cmpWired = "1";

  const imgA = frame.querySelector(".cmp-img-a");
  const handle = frame.querySelector(".cmp-handle");
  if (!imgA || !handle) return;

  let split = 0.5;
  const apply = () => {
    handle.style.left = `${(split * 100).toFixed(3)}%`;
    imgA.style.clipPath = `inset(0 ${((1 - split) * 100).toFixed(3)}% 0 0)`;
  };
  apply();

  const setAt = (clientX) => {
    const r = frame.getBoundingClientRect();
    if (r.width <= 0) return;
    split = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    apply();
  };

  // Per-frame pointer state. activePid scopes the document listeners
  // to the pointer that started on this specific frame, so two
  // adjacent compare frames don't interfere with each other.
  let activePid = null;

  const onMove = (e) => {
    if (activePid === null || e.pointerId !== activePid) return;
    setAt(e.clientX);
    e.preventDefault();
  };

  const onUp = (e) => {
    if (activePid === null) return;
    if (e && e.pointerId !== undefined && e.pointerId !== activePid) return;
    activePid = null;
    document.removeEventListener("pointermove",   onMove);
    document.removeEventListener("pointerup",     onUp);
    document.removeEventListener("pointercancel", onUp);
  };

  frame.addEventListener("pointerdown", (e) => {
    // Left button / primary touch only — and don't fight other handlers
    // (e.g., the asset card's text-selection on the body).
    if (e.button !== undefined && e.button !== 0) return;
    activePid = e.pointerId;
    setAt(e.clientX);
    e.preventDefault();
    e.stopPropagation();
    // Document-level follow-up — survives the finger leaving the
    // frame's bounding box on phones, which the previous
    // frame.setPointerCapture pattern could not when the frame sat
    // inside an overflow:auto parent (asset hover card).
    document.addEventListener("pointermove",   onMove);
    document.addEventListener("pointerup",     onUp);
    document.addEventListener("pointercancel", onUp);
  });

  // Explicit touchstart preventDefault (non-passive) — see header
  // comment. Without this, iOS may commit to a scroll gesture in the
  // first few pixels of touch movement before pointerdown's
  // preventDefault has a chance to claim the gesture.
  frame.addEventListener("touchstart", (e) => {
    e.preventDefault();
  }, { passive: false });
}

const HOTSPOT_VIS_STORAGE_KEY = "playsplat:hotspot-visibility:v1";

export class TechSpec {
  constructor({ mountEl = document.body } = {}) {
    this.open = false;
    // Per-asset hotspot visibility. Map<name, boolean>. Missing key == ON.
    // Persisted across reloads via localStorage.
    this.assetVisible = this._loadVisibility();
    this.onAssetToggle = null;   // (name, on) => void — wired by main.js

    this.el = document.createElement("div");
    this.el.id = "tech-spec";
    this.el.innerHTML = `
      <div class="ts-backdrop"></div>
      <aside class="ts-panel">
        <header class="ts-header">
          <div class="ts-title">
            <span class="dot"></span>
            <span class="t">TECH BREAKDOWN</span>
            <span class="ts-key">T</span>
          </div>
          <button class="ts-close" title="Close (T or Esc)">×</button>
        </header>
        <div class="ts-sub">How everything in this scene was made · click a section to fold</div>
        <nav class="ts-toc" aria-label="Tech Breakdown sections">
          ${TECH_SPECS.map((s, i) => `
            <button class="ts-toc-pill${i === 0 ? " active" : ""}"
                    type="button"
                    data-toc-target="${i}"
                    title="Jump to ${escapeHtml(s.section)}">${escapeHtml(s.section)}</button>
          `).join("")}
        </nav>
        <div class="ts-body">
          ${TECH_SPECS.map((s, i) => {
            const groupCls = s.group ? ` ts-sec-${s.group}` : "";
            const numChip  = (s.layerNum != null)
              ? `<span class="ts-sec-num">L${s.layerNum}</span>`
              : (s.pillarIdx
                  ? `<span class="ts-sec-num">${String(s.pillarIdx).padStart(2, "0")}</span>`
                  : "");
            const itemLbl  = s.items.length === 1 ? "item" : "items";
            // Layer sections show their tool stack as a chip row in the
            // header — readable even when the section is collapsed.
            const layerTools = (s.group === "layer" && Array.isArray(s.toolchain))
              ? `<div class="ts-sec-tools">${s.toolchain.map(t => `<span class="ts-chip">${t}</span>`).join("")}</div>`
              : "";
            return `
              <section class="ts-sec${groupCls}" data-idx="${i}">
                <header class="ts-sec-head">
                  ${numChip}
                  <span class="ts-sec-name">${s.section}</span>
                  <span class="ts-sec-count">${s.items.length} ${itemLbl}</span>
                  <span class="ts-caret">▾</span>
                </header>
                <div class="ts-sec-desc">${s.desc}</div>
                ${layerTools}
                <ul class="ts-list">
                  ${s.items.map(it => renderItem(it, this.assetVisible)).join("")}
                </ul>
              </section>`;
          }).join("")}
        </div>
        <footer class="ts-footer">
          <span class="ts-foot-k">Total</span>
          <span class="ts-foot-v"><span class="ticker" data-target="${TECH_SPECS.reduce((n, s) => n + s.items.length, 0)}">0</span> entries · <span class="ticker" data-target="${TECH_SPECS.length}">0</span> sections</span>
        </footer>
      </aside>
    `;
    mountEl.appendChild(this.el);

    this.el.querySelector(".ts-close").addEventListener("click", () => this.close());

    // Click-outside-to-minimize. The drawer is a reading surface layered
    // over the live scene, so a press anywhere outside .ts-panel reads as
    // "done — take me back to the garden" and folds the drawer away. This
    // mirrors the Credits panel's _onOutsidePointerDown dismiss, captured
    // on pointerdown so it fires ahead of any downstream handler. The
    // backdrop is pointer-events:none, so a press in the empty region to
    // the left of the panel actually lands on the canvas underneath — that
    // target is outside .ts-panel, so it correctly closes the drawer.
    // Close still works via the × button, the T toggle, and Esc too.
    //
    // Skips .lil-gui targets for parity with Credits. While the drawer is
    // open the Studio panel is slid off-screen + pointer-events:none
    // (body.tech-spec-open), so this guard is belt-and-braces rather than
    // load-bearing, but it avoids folding on a stray control poke during
    // the slide transition.
    this._onOutsidePointerDown = (e) => {
      if (!this.open) return;
      const panel = this.el.querySelector(".ts-panel");
      if (panel && panel.contains(e.target)) return;
      if (e.target?.closest?.(".lil-gui")) return;
      this.close();
    };

    this.el.querySelectorAll(".ts-sec-head").forEach(h => {
      h.addEventListener("click", () => {
        const sec = h.closest(".ts-sec");
        sec.classList.toggle("collapsed");
      });
    });

    // Asset-level accordion. Each .ts-item-asset has a clickable
    // .ts-item-head; clicking (or Enter / Space on a focused head)
    // toggles `.collapsed` on the item to show / hide its body. The
    // hotspot ON/OFF pill inside the head already stopPropagation()s
    // so it won't accidentally fold the card. Delegated on this.el
    // so the listener survives any future re-render.
    //
    // Clicks inside the body (compare slider, embed, etc.) must NOT
    // bubble up and fold the card — that would be infuriating. We
    // identify "header click" strictly via `e.target.closest('.ts-item-head')`
    // AND we walk up to the nearest `.ts-item-asset`; if that's not
    // the same node as the head's parent, ignore (defensive).
    const toggleItem = (item, btn) => {
      const now = item.classList.toggle("collapsed");
      btn.setAttribute("aria-expanded", now ? "false" : "true");
      btn.setAttribute("title", now ? "Click to expand" : "Click to collapse");
      // If we just expanded an item that contains compare frames, the
      // drag handles were wired at construction time so they still work
      // — no re-wiring needed (display:none doesn't detach listeners).
    };
    this.el.addEventListener("click", (e) => {
      // Ignore clicks that originated on an interactive child of the
      // head (the hotspot toggle button); stopPropagation in that
      // handler already prevents this from firing, but we double-check
      // in case some future child forgets.
      if (e.target?.closest?.('[data-act="toggle-hotspot"]')) return;
      const head = e.target?.closest?.(".ts-item-asset > .ts-item-head");
      if (!head || !this.el.contains(head)) return;
      const item = head.parentElement;
      toggleItem(item, head);
    });
    this.el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      // Only act when the head ITSELF has focus — not when focus is on
      // the hotspot button nested inside it. Otherwise Enter on the
      // button would fire both the button's native click AND a
      // preventDefault-blocked accordion toggle, masking the toggle's
      // click handler.
      if (!(e.target instanceof HTMLElement)) return;
      if (!e.target.classList.contains("ts-item-head")) return;
      if (!e.target.parentElement?.classList.contains("ts-item-asset")) return;
      e.preventDefault();
      toggleItem(e.target.parentElement, e.target);
    });

    // Sticky TOC at the top of the drawer — table of contents pill row
    // listing every TECH_SPECS section. Two interactions:
    //   1) Click pill → smooth-scroll the body to that section's top
    //      AND auto-expand the section if it was collapsed (otherwise
    //      the click would land on a collapsed header showing nothing).
    //   2) Scroll-spy → as the user scrolls the body, the pill matching
    //      the topmost-visible section gets .active so the reader
    //      always knows where they are in the long content.
    //
    // The body is a nested scroll container (overflow-y: auto), so we
    // compute scroll target via getBoundingClientRect against the body
    // rather than scrollIntoView which would also scroll the page. rAF
    // throttles the scroll-spy so a fast flick doesn't burn the main
    // thread.
    const bodyEl = this.el.querySelector(".ts-body");
    const tocPills = Array.from(this.el.querySelectorAll(".ts-toc-pill"));
    const sectionEls = Array.from(this.el.querySelectorAll(".ts-sec"));

    tocPills.forEach(pill => {
      pill.addEventListener("click", () => {
        const idx = Number(pill.dataset.tocTarget);
        const sec = sectionEls[idx];
        if (!sec) return;
        sec.classList.remove("collapsed");
        const bodyRect = bodyEl.getBoundingClientRect();
        const secRect  = sec.getBoundingClientRect();
        const offset   = (secRect.top - bodyRect.top) + bodyEl.scrollTop;
        bodyEl.scrollTo({ top: offset, behavior: "smooth" });
      });
    });

    let _tocSpyScheduled = false;
    const updateActivePill = () => {
      _tocSpyScheduled = false;
      const bodyTop = bodyEl.getBoundingClientRect().top;
      // Pick the section whose top is at or just above the viewport's
      // top edge (offset by a small fudge so a section that just barely
      // peeked out of view still counts as "current").
      const fudge = 80;
      let activeIdx = 0;
      let bestTop  = -Infinity;
      sectionEls.forEach((sec, i) => {
        const rel = sec.getBoundingClientRect().top - bodyTop;
        if (rel <= fudge && rel > bestTop) {
          bestTop = rel;
          activeIdx = i;
        }
      });
      tocPills.forEach((p, i) => p.classList.toggle("active", i === activeIdx));
      // Keep the active pill visible inside the horizontally-scrollable
      // TOC strip — on phone where the strip overflows, the active pill
      // may otherwise be off-screen after a long scroll.
      const activePill = tocPills[activeIdx];
      if (activePill) {
        activePill.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
      }
    };
    bodyEl.addEventListener("scroll", () => {
      if (_tocSpyScheduled) return;
      _tocSpyScheduled = true;
      requestAnimationFrame(updateActivePill);
    }, { passive: true });

    // Hotspot ON/OFF toggle on each asset item. Delegated so the listener
    // survives any future re-render. stopPropagation keeps the section
    // collapse handler above from firing.
    this.el.addEventListener("click", (e) => {
      const btn = e.target?.closest?.('[data-act="toggle-hotspot"]');
      if (!btn || !this.el.contains(btn)) return;
      e.stopPropagation();
      const name = btn.dataset.assetName;
      const next = !(this.assetVisible.get(name) !== false);
      this.assetVisible.set(name, next);
      btn.dataset.on = next ? "1" : "0";
      btn.setAttribute("aria-pressed", next ? "true" : "false");
      const lbl = btn.querySelector(".ts-toggle-label");
      if (lbl) lbl.textContent = next ? "ON" : "OFF";
      this._saveVisibility();
      this.onAssetToggle?.(name, next);
    });

    // Wire drag handles on every inline before/after compare widget.
    this.el.querySelectorAll(".ts-compare .cmp-frame").forEach(wireCompareFrame);

    // T key toggles, Esc closes — guarded against typing into inputs.
    window.addEventListener("keydown", (e) => {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      if (e.key === "t" || e.key === "T") this.toggle();
      else if (e.key === "Escape" && this.open) this.close();
    });
  }

  toggle()      { this.open ? this.close() : this.openOverlay(); }
  openOverlay() {
    this.open = true;
    this.el.classList.add("show");
    // Fire the rolling-digit tickers in the Overview output line + footer
    // counts. We pass observe:false (skip IntersectionObserver) because
    // the drawer's slide-in transform + internal overflow scroll can
    // confuse the observer's intersection geometry — the safer + more
    // reliable behaviour here is "drawer opens → all tickers fire". Each
    // ticker self-marks as active on first call so subsequent open/close
    // cycles don't restart the animation.
    initTickers(this.el, { observe: false });
    // Auto-fit every Vimeo iframe in the drawer to its clip's real
    // dimensions — eliminates Vimeo's internal letterbox bars for any
    // asset card that ships an embed. Idempotent so repeated opens
    // don't re-measure.
    fitVimeoFrames(this.el);
    this.onOpenChange?.(true);
    // Defer attaching the outside-click dismiss one macrotask so the very
    // press that opened the drawer (About CTA / mobile-sheet button) can't
    // bubble straight into this listener and re-close it on the same gesture.
    setTimeout(() => {
      if (this.open) document.addEventListener("pointerdown", this._onOutsidePointerDown, true);
    }, 0);
  }
  close() {
    this.open = false;
    this.el.classList.remove("show");
    document.removeEventListener("pointerdown", this._onOutsidePointerDown, true);
    this.onOpenChange?.(false);
  }

  /**
   * Open the drawer scrolled to the given asset and expand its
   * accordion. Used by the URL-hash deep-link (`#asset=Foliage`) so a
   * shared link can land the reader directly on a specific asset card
   * instead of the top of the drawer. Match is case-insensitive on the
   * asset's display name; unknown names fall back to opening the drawer
   * at the default scroll position. Returns true if a matching asset
   * was found, false otherwise.
   */
  openToAsset(assetName) {
    if (!this.open) this.openOverlay();
    if (!assetName) return false;
    const needle = String(assetName).trim().toLowerCase();
    if (!needle) return false;
    // Locate the .ts-item-asset whose name h3 matches. We walk the live
    // DOM rather than the TECH_SPECS data because the click-to-expand
    // and scroll-into-view operations are DOM-side anyway, and the data
    // model has no element handle. requestAnimationFrame defers the
    // scroll/expand until after openOverlay's class flip has rendered
    // so the geometry is settled.
    requestAnimationFrame(() => {
      const items = this.el.querySelectorAll(".ts-item-asset");
      for (const li of items) {
        const nameEl = li.querySelector(".ts-item-name");
        const name   = nameEl?.textContent?.trim().toLowerCase() ?? "";
        if (name === needle) {
          // Expand if currently collapsed.
          if (li.classList.contains("collapsed")) {
            li.classList.remove("collapsed");
            const head = li.querySelector(".ts-item-head");
            head?.setAttribute("aria-expanded", "true");
            head?.setAttribute("title", "Click to collapse");
          }
          // Smooth-scroll the drawer body so the asset header lands near
          // the top, just below the sticky TOC pill row.
          const bodyEl = this.el.querySelector(".ts-body");
          if (bodyEl) {
            const bodyRect = bodyEl.getBoundingClientRect();
            const liRect   = li.getBoundingClientRect();
            const offset   = (liRect.top - bodyRect.top) + bodyEl.scrollTop - 12;
            bodyEl.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
          }
          return;
        }
      }
    });
    return true;
  }

  _loadVisibility() {
    try {
      const raw = localStorage.getItem(HOTSPOT_VIS_STORAGE_KEY);
      if (!raw) return new Map();
      const obj = JSON.parse(raw);
      return new Map(Object.entries(obj));
    } catch { return new Map(); }
  }
  _saveVisibility() {
    try {
      const obj = Object.fromEntries(this.assetVisible);
      localStorage.setItem(HOTSPOT_VIS_STORAGE_KEY, JSON.stringify(obj));
    } catch { /* quota / disabled — silent */ }
  }
}
