// ---------------------------------------------------------------------------
// AssetHoverManager — projects each TECH_SPECS asset's worldPos onto the
// viewport as a small hotspot dot. Hovering a dot pops a poster-style
// overlay card with the asset's authoring detail (toolchain chips, media
// comparison grid, key feature bullets, notes, output).
//
// Scaffolding only — media slots show "placeholder" until the user supplies
// the lookdev / texture imagery and patches `tech-spec.js` items with
// `media: { style, original, result, ... }` fields.
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { renderCompare, wireCompareFrame } from "./tech-spec.js";
import { haptic }    from "./haptic.js";
import { playSound } from "./sounds.js";
import { fitVimeoFrames } from "./vimeo-fit.js";

const _v = new THREE.Vector3();

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/**
 * Escape HTML but PRESERVE `**bold**` inline markdown — used for bullet
 * values where emphasis carries meaning (e.g., "Apply **Attribute Transfer
 * node** to transfer color"). Escapes everything else (angle brackets,
 * quotes, ampersands) so user-authored content can't inject markup. The
 * order matters: escape FIRST, then convert the escaped asterisk pairs
 * into <strong> tags — that way the user can write `**` literally without
 * worrying about HTML at all.
 */
export function escapeHtmlInlineBold(s) {
  return escapeHtml(s).replace(
    /\*\*([^*]+)\*\*/g,
    "<strong>$1</strong>",
  );
}

export function renderSimVideo(v) {
  if (!v) return "";
  const flags = [
    v.autoplay ? "autoplay" : "",
    v.muted    ? "muted"    : "",
    v.loop     ? "loop"     : "",
    "playsinline",
  ].filter(Boolean).join(" ");
  const poster = v.poster ? ` poster="${escapeHtml(v.poster)}"` : "";
  const inner = v.url
    ? `<video class="ah-sim-video" src="${escapeHtml(v.url)}" ${flags}${poster}></video>`
    : `<div class="ah-sim-ph">
         <div class="ah-sim-ph-eyebrow">Houdini 3DGS SIM</div>
         <div class="ah-sim-ph-body">drop a .mp4 / .webm into <code>simVideo.url</code></div>
       </div>`;
  return `
    <section class="ah-section ah-sim">
      <div class="ah-sec-title">${escapeHtml(v.label || "Simulation")}</div>
      <div class="ah-sim-frame">${inner}</div>
    </section>`;
}

export function renderEmbed(e) {
  if (!e || !e.src) return "";
  // Default 16:9; per-asset embeds can override with e.aspectRatio
  // (any valid CSS aspect-ratio value, e.g. "3 / 2" or "1000 / 667").
  const aspectStyle = e.aspectRatio ? ` style="aspect-ratio: ${escapeHtml(e.aspectRatio)};"` : "";
  return `
    <section class="ah-section ah-embed">
      <div class="ah-sec-title">${escapeHtml(e.label || "Video")}</div>
      <div class="ah-embed-frame"${aspectStyle}>
        <iframe
          src="${escapeHtml(e.src)}"
          title="${escapeHtml(e.title || e.label || "embedded video")}"
          loading="lazy"
          allow="autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media; web-share"
          referrerpolicy="strict-origin-when-cross-origin"
          allowfullscreen></iframe>
      </div>
    </section>`;
}

function renderToolchain(items) {
  if (!Array.isArray(items) || items.length === 0) return "";
  // Plain chip list — no ▸ arrow separators. The label was renamed
  // from "Toolchain" to "Keywords", which means these are tags, not a
  // sequence of pipeline stages. Arrows implied directional flow which
  // is misleading now; chips are just space-separated. The .ah-chain
  // CSS uses flex gap for breathing room between chips.
  return items.map(t => `<span class="ah-chip">${escapeHtml(t)}</span>`).join("");
}

// Process-card renderer — supports TWO styles for rich design-walkthrough
// cards. The renderer detects which style to use from the card's fields.
//
// STYLE A — chip-labeled (compact, used by Foliage):
//   { label: "Modeling and Optimization",
//     rows: [{layout, items}], note: "bottom paragraph" }
//   Renders: chip header · rows with captions BELOW images · optional note
//
// STYLE B — step / numbered (eyebrow + bold title + description prose +
// captions ABOVE, used by Grape Hyacinth's 01/02/03 sections):
//   { eyebrow: "01 — PROCEDURAL TOOL",
//     title:   "Houdini Tool — Procedural Grape Hyacinth",
//     description: "Body prose explaining the step…",
//     rows: [{layout, items}] }
//   Renders: small uppercase eyebrow · bold title h3 · description prose ·
//   rows with captions ABOVE images. No bottom note (description carries
//   the prose).
//
// Row items support BOTH images and Vimeo iframes:
//   { src: "/path/to/img.png", caption: "…" }    → <img>
//   { iframeSrc: "https://player.vimeo.com/…",
//     caption: "…", aspectRatio: "16/9" }        → <iframe>
//
// Style detection: presence of `eyebrow` OR `title` → Style B; else
// Style A. This keeps existing chip-style cards (Foliage)
// untouched while allowing the new step style for Grape Hyacinth.

function renderProcessCardItem(item /* captionAbove unused — always below */) {
  if (!item) return "";
  const isIframe = !!item.iframeSrc;
  const inner = isIframe
    ? `<iframe src="${escapeHtml(item.iframeSrc)}"
              title="${escapeHtml(item.alt || item.caption || "embedded video")}"
              loading="lazy"
              allow="autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media; web-share"
              referrerpolicy="strict-origin-when-cross-origin"
              allowfullscreen></iframe>`
    : (item.src ? `<img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.alt || item.caption || "")}">` : "");
  if (!inner) return "";
  // Per-item aspectRatio (e.g. for an unusually-shaped iframe) overrides
  // the row's default plinth ratio set by CSS.
  const aspectStyle = item.aspectRatio
    ? ` style="aspect-ratio: ${escapeHtml(item.aspectRatio)};"`
    : "";
  const cap = item.caption
    ? `<figcaption>${escapeHtml(item.caption)}</figcaption>`
    : "";
  // All captions render BELOW their content (image or video) per user
  // visual rhythm consistent across cards and matches the standard
  // figure → figcaption flow. The .ah-pc-fig-cap-above CSS variant
  // is left in style.css dormant in case a future card wants captions
  // above; nothing currently uses it.
  return `<figure class="ah-pc-fig">
            <div class="ah-frame"${aspectStyle}>${inner}</div>
            ${cap}
          </figure>`;
}

function renderProcessCard(card) {
  if (!card) return "";
  // A card needs SOMETHING to render — either media rows, or bullet
  // content (points / groups), or at least a header (eyebrow / title /
  // label). Bullets-only cards (like Particles' "Key Process") were
  // silently dropping out under the old "rows required" check, which
  // is why the Key Process bullets were invisible while the asset's
  // top-level `note` ended up filling the void at the bottom of the
  // card. The four sentinels below let any one of header / rows /
  // points / groups carry the card on its own.
  const hasRows   = Array.isArray(card.rows)   && card.rows.length   > 0;
  const hasPoints = Array.isArray(card.points) && card.points.length > 0;
  const hasGroups = Array.isArray(card.groups) && card.groups.length > 0;
  const hasHeader = !!(card.eyebrow || card.title || card.label || card.description);
  if (!hasRows && !hasPoints && !hasGroups && !hasHeader) return "";
  // Detect style by presence of eyebrow/title (Style B) vs label (Style A).
  const isStep = !!(card.eyebrow || card.title);

  const sectionClass = isStep ? "ah-section ah-pc-step" : "ah-section ah-pc-flat";

  // Chip-style header → use the standard .ah-sec-title (uppercase
  // letter-spaced label) so it visually matches Gazebo's section
  // headers exactly. Step-style header keeps its eyebrow + bold title
  // + description typography (Grape Hyacinth's richer narrative).
  const header = isStep
    ? `${card.eyebrow ? `<div class="ah-pc-eyebrow">${escapeHtml(card.eyebrow)}</div>` : ""}
       ${card.title   ? `<h3 class="ah-pc-title">${escapeHtml(card.title)}</h3>` : ""}
       ${card.description ? `<p class="ah-pc-desc">${escapeHtml(card.description)}</p>` : ""}`
    : (card.label ? `<div class="ah-sec-title">${escapeHtml(card.label)}</div>` : "");

  // Guarded against undefined `rows` because cards can now be
  // bullets-only (see the sentinels above the renderProcessCard
  // early-return). `(card.rows || [])` makes the map a safe no-op.
  const rows = (card.rows || []).map(r => {
    // Optional per-row sub-heading. Applied to every layout below so a
    // card can mix compare / single / pair / quad rows under a unified
    // sub-section header treatment. Computed once up here so the
    // compare branch (which early-returns) and the standard branch
    // both consume the same string. See the CSS rule for the
    // doubled-separator suppression when a heading immediately follows
    // the card title block.
    const heading = r.heading
      ? `<h4 class="ah-pc-row-heading">${escapeHtml(r.heading)}</h4>`
      : "";

    // Compare-slider row: one or more A/B wipe widgets driven by the
    // existing tech-spec.js helpers. Two schemas accepted:
    //   • Single compare — row itself carries { before, after, labelA,
    //     labelB, aspectRatio? }
    //   • Multiple compares — row carries `items: [{ before, after, ...}]`
    //     and each compare lays out side-by-side in a grid (1 item =
    //     full-width, 2 items = pair, 3+ items = auto-fit grid).
    // Default aspectRatio is "1 / 1" (Substance texture pairs are
    // typically square); override per-item or per-row for landscape /
    // portrait sources via e.g. "16 / 9".
    if (r.layout === "compare") {
      const items = Array.isArray(r.items) && r.items.length
        ? r.items
        : [r];   // back-compat: treat the row itself as one compare
      const aspect    = r.aspectRatio || "1 / 1";
      const pairClass = items.length > 1 ? " ah-pc-compare-grid" : "";
      const inner = items.map(c => {
        const a = c.aspectRatio || aspect;
        return `<div class="ah-pc-cmp-cell" style="--cmp-aspect: ${a};">${renderCompare(c)}</div>`;
      }).join("");
      return `${heading}<div class="ah-pc-row ah-pc-compare${pairClass}" style="--cmp-aspect: ${aspect};">${inner}</div>`;
    }
    // Layout primitives:
    //   single — one media item, full row width, natural aspect
    //   pair   — 2 items, side-by-side. Opt-in equal-height via
    //            `aspectRatio` on the row (--pair-aspect CSS var)
    //   quad   — 4 items in a row (used for texture-map showcases —
    //            BaseColor / Normal / ORM / ScatterMask etc.). Stacks
    //            to 2x2 on phones via the .ah-pc-quad media query in
    //            style.css. Equal-height by default; aspect override
    //            via row.aspectRatio (defaults to 1:1 — texture maps
    //            are typically square).
    let layout;
    if      (r.layout === "pair") layout = "ah-pc-pair";
    else if (r.layout === "quad") layout = "ah-pc-quad";
    else                          layout = "ah-pc-single";
    const items  = (r.items || []).map(renderProcessCardItem).join("");
    // Both pair and quad rows can OPT IN to equal-height cells by
    // declaring an `aspectRatio` on the row (e.g. "16 / 9" / "1 / 1").
    // The CSS keys off `style*="--pair-aspect"` for pair rows and
    // `--quad-aspect` for quad rows so the modes stay independent.
    let aspectStyle = "";
    if (r.layout === "pair" && r.aspectRatio) {
      aspectStyle = ` style="--pair-aspect: ${escapeHtml(r.aspectRatio)};"`;
    } else if (r.layout === "quad") {
      // quad ALWAYS has an aspect (defaults to 1/1) so cells line up.
      const qa = r.aspectRatio || "1 / 1";
      aspectStyle = ` style="--quad-aspect: ${escapeHtml(qa)};"`;
    }
    // `heading` was already computed at the top of this iteration so
    // both the compare branch (early return above) and this default
    // branch consume the same string. No re-declaration here.
    return `${heading}<div class="ah-pc-row ${layout}"${aspectStyle}>${items}</div>`;
  }).join("");

  // In-section bullet list — used by Vine's "WPO Dynamic Material
  // Blueprint" step where the bullets (UV Directional Masking / Vertex
  // Color Control / WPO / etc.) describe controls SPECIFIC to that
  // step's blueprint screenshot. Distinct from the global `keyPoints`
  // field which renders once at the bottom of the asset card.
  // Schema: same as keyPoints — array of { key, value } objects with
  // optional key (renders as bold leader before the value).
  const points = Array.isArray(card.points) && card.points.length
    ? `<ul class="ah-pc-points">
         ${card.points.map(p => {
           if (!p || !p.value) return "";
           const k = p.key ? `<strong>${escapeHtml(p.key)}:</strong> ` : "";
           return `<li>${k}${escapeHtmlInlineBold(p.value)}</li>`;
         }).join("")}
       </ul>`
    : "";

  // Grouped points — used by Gazebo's "Key Process" step where
  // multiple sub-topics (Simulation Mask · Velocity from Pyro · ...)
  // each carry their own bullet list. The flat `points` field above
  // can't express the hierarchy. Schema:
  //   groups: [{ heading: "Topic", items: ["bullet", { key, value }] }]
  // Each item can be a string OR { key, value } object (same shape as
  // `points`). Inline **bold** is supported in both string items and
  // object values via escapeHtmlInlineBold.
  const groups = Array.isArray(card.groups) && card.groups.length
    ? card.groups.map(g => {
        if (!g) return "";
        const heading = g.heading
          ? `<div class="ah-pc-group-heading">${escapeHtml(g.heading)}</div>`
          : "";
        const items = Array.isArray(g.items) ? g.items : [];
        const lis = items.map(it => {
          if (typeof it === "string") return `<li>${escapeHtmlInlineBold(it)}</li>`;
          if (it && it.value) {
            const k = it.key ? `<strong>${escapeHtml(it.key)}:</strong> ` : "";
            return `<li>${k}${escapeHtmlInlineBold(it.value)}</li>`;
          }
          return "";
        }).join("");
        const ul = lis ? `<ul class="ah-pc-group-points">${lis}</ul>` : "";
        return `<div class="ah-pc-group">${heading}${ul}</div>`;
      }).join("")
    : "";

  // Note is interpolated raw (no escapeHtml) for the same reason the
  // source field is — the value is author-controlled (defined in
  // tech-spec.js, never user input), so it can carry inline HTML like
  // <strong>, <br>, and <a> links. The Foliage card's section-3 note,
  // for example, ends with a clickable "Inspired by:" 80.lv citation
  // that lives inside this note rather than in the asset-level source
  // footer because the Figma reference shows it right after the
  // paragraph in the same section block.
  const note = card.note
    ? `<div class="ah-pc-note">${card.note}</div>`
    : "";

  return `<section class="${sectionClass}">${header}${rows}${points}${groups}${note}</section>`;
}

export function renderProcessCards(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return "";
  // No outer wrapping — each card is its own flat section, joined inline
  // as siblings of the other top-level sections in the card body.
  return cards.map(renderProcessCard).join("");
}

// Key-points renderer — bulleted summary at the bottom of an asset card,
// each row is { key: "Houdini", value: "Modeled entirely in…" } and
// renders as a list with the key bolded inline. Used by Grape Hyacinth's
// Houdini/Unreal/Performance/Rendering wrap-up bullets. Opt-in per asset
// via `keyPoints: [...]`; absence renders nothing.
export function renderKeyPoints(points) {
  if (!Array.isArray(points) || points.length === 0) return "";
  const lis = points.map(p => {
    if (!p || !p.value) return "";
    const k = p.key ? `<strong>${escapeHtml(p.key)}:</strong> ` : "";
    return `<li>${k}${escapeHtml(p.value)}</li>`;
  }).join("");
  return `
    <section class="ah-section ah-keypoints">
      <ul>${lis}</ul>
    </section>`;
}

// Exported so mobile-ui.js can reuse the exact same markup inside a
// bottom-sheet on long-press. Kept here (not promoted to its own module)
// because all the section-renderers above are private helpers and the
// schema is co-located with the card layout.
export function renderCard(it) {
  const tc = renderToolchain(it.toolchain);
  const features = it.keyFeatures ?? [];
  const media    = it.media ?? {};

  return `
    <button class="ah-close" data-act="close" title="Close">×</button>
    <header class="ah-head">
      <div class="ah-name">${escapeHtml(it.name)}</div>
      ${it.location ? `<span class="ah-loc">${escapeHtml(it.location)}</span>` : ""}
    </header>

    ${tc ? `<section class="ah-section">
      <div class="ah-sec-title">Keywords</div>
      <div class="ah-chain">${tc}</div>
    </section>` : ""}

    ${it.simVideo ? renderSimVideo(it.simVideo) : ""}

    ${Array.isArray(it.embed)
        ? it.embed.map(e => renderEmbed(e)).join("")
        : (it.embed ? renderEmbed(it.embed) : "")}

    ${/* processCards render AFTER embeds — Daffodil keeps its existing
        VAT+OSC video at the top, then the rich Houdini Simulation /
        Texturing process cards appear below it. Per user direction
        Foliage have no separate `embed` field so this ordering doesn't
        affect them — their processCards still render right after the
        Keywords zone. */
      renderProcessCards(it.processCards)}

    ${(media.style || media.original || media.result) ? `<section class="ah-section ah-media-row">
      <div class="ah-sec-title">Texture Stylization</div>
      <div class="ah-triptych">
        <figure>
          <div class="ah-frame">${media.style ? `<img src="${escapeHtml(media.style)}" alt="Style reference">` : `<div class="ah-ph">placeholder</div>`}</div>
          <figcaption>Style Reference</figcaption>
        </figure>
        <figure>
          <div class="ah-frame">${media.original ? `<img src="${escapeHtml(media.original)}" alt="Original texture">` : `<div class="ah-ph">placeholder</div>`}</div>
          <figcaption>Original Texture</figcaption>
        </figure>
        <figure>
          <div class="ah-frame">${media.result ? `<img src="${escapeHtml(media.result)}" alt="Result">` : `<div class="ah-ph">placeholder</div>`}</div>
          <figcaption>Result</figcaption>
        </figure>
      </div>
    </section>` : ""}

    ${features.length > 0 ? `<section class="ah-section">
      <div class="ah-sec-title">Key Features</div>
      <ul class="ah-bullets">
        ${features.map(f => `<li>${escapeHtml(f)}</li>`).join("")}
      </ul>
    </section>` : ""}

    ${Array.isArray(media.pipeline) && media.pipeline.length > 0 ? `<section class="ah-section">
      <div class="ah-sec-title">Pipeline</div>
      <div class="ah-strip">
        ${media.pipeline.map(p => `
          <figure>
            <div class="ah-frame">${p.src ? `<img src="${escapeHtml(p.src)}" alt="${escapeHtml(p.label ?? "")}">` : `<div class="ah-ph">placeholder</div>`}</div>
            <figcaption>${escapeHtml(p.label ?? "")}</figcaption>
          </figure>
        `).join("")}
      </div>
    </section>` : ""}

    ${it.note ? `<section class="ah-section ah-note">${escapeHtml(it.note)}</section>` : ""}

    ${renderKeyPoints(it.keyPoints)}

    ${it.compare ? `<section class="ah-section">
      <div class="ah-sec-title">Before / After</div>
      ${renderCompare(it.compare)}
    </section>` : ""}

    <footer class="ah-foot">
      ${it.output ? `<div class="ah-foot-row"><span class="ah-k">Output</span><span class="ah-v">${escapeHtml(it.output)}</span></div>` : ""}
      ${it.source ? `<div class="ah-foot-row"><span class="ah-k">Source</span><span class="ah-v">${it.source}</span></div>` : ""}
      ${it.worldPos ? `<div class="ah-foot-row"><span class="ah-k">Pos</span><span class="ah-v">${it.worldPos.map(n => Number(n).toFixed(3)).join(", ")}</span></div>` : ""}
    </footer>
  `;
}

export class AssetHoverManager {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.mountEl   — container for dots + card
   * @param {THREE.Camera} opts.camera
   * @param {HTMLCanvasElement} opts.canvas
   * @param {Array}  opts.items          — TECH_SPECS items (with worldPos[])
   *
   * `worldPos` values are picked from the artist's source tool. That tool
   * exports with +Z forward (into the scene); Three.js uses -Z forward.
   * X and Y axes already match. We therefore flip Z only when projecting
   * to land the dots on the actual asset in the rendered scene.
   */
  constructor({ mountEl, camera, canvas, items }) {
    this.camera         = camera;
    this.canvas         = canvas;
    this.items          = (items || []).filter(it => Array.isArray(it.worldPos));
    this._pinned        = null;   // item locked open by click — survives mouseleave
    this._visible       = true;   // whole layer toggle; user-uploaded splats hide it
    this._hiddenNames   = new Set();   // per-asset toggle from the Pipeline drawer
    this.onAssetSelect  = null;   // called with the item on click (camera fly-to hook)
    this.onAssetShortTap = null;  // touch: short tap, after fly-to (toast hook)
    this.onAssetLongPress = null; // touch: long-press (detail-sheet hook)
    this._longPressFired = false; // swallows the trailing click after a long-press

    // Touch-mode flag drives the pointer-based tap detection (more
    // reliable than `click` when the dot is being transformed each
    // frame). On phone we ALSO fire `onAssetShortTap` so the mobile
    // bottom-sheet UI can open the asset card. On tablet (iPad) we
    // mirror desktop click behavior — toggle the floating hover card
    // — because the user wants iPad === PC visually.
    const IS_TOUCH = document.body.classList.contains("touch");
    const IS_PHONE_MODE = IS_TOUCH && document.body.classList.contains("mobile");

    this.dots = this.items.map((it, idx) => {
      // Promoted from <div> to <button> so VoiceOver / screen readers
      // announce it as a proper interactive control. The aria-label
      // reads the asset name aloud; visually nothing changes (the
      // .asset-hotspot CSS already resets all native button chrome).
      // The new .ahot-burst element is a normally-invisible ring that
      // gets a 300 ms expanding-out animation when the asset is tapped
      // — closes the "camera moves but the asset stays silent" feedback
      // gap the HIG audit flagged (Strategic #1).
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "asset-hotspot";
      dot.setAttribute("aria-label", `Asset · ${it.name}`);
      // Per-dot stagger index → CSS uses --i * 50ms for the entrance
      // animation-delay so the dots fade in one after another instead of
      // appearing as a synchronised blob. Reads as choreography.
      dot.style.setProperty("--i", String(idx));
      dot.innerHTML = `
        <span class="ahot-ring"></span>
        <span class="ahot-burst" aria-hidden="true"></span>
        <span class="ahot-dot"></span>
        <span class="ahot-label">${escapeHtml(it.name)}</span>
      `;
      // Helper: fire the tap-reactivity animation. Adding the class
      // restarts the keyframe each time (we re-add after a frame so a
      // double-tap re-triggers cleanly). Pairs with the camera fly-to
      // so the user gets BOTH a transit AND a "yes, this is the thing"
      // micro-reveal at the hotspot location.
      const fireBurst = () => {
        dot.classList.remove("asset-hotspot--firing");
        // Force reflow so the animation restarts on rapid taps.
        void dot.offsetWidth;
        dot.classList.add("asset-hotspot--firing");
        // Sync with the CSS keyframe duration; class is removed after
        // so the dot returns to its idle pulse + can re-fire later.
        setTimeout(() => dot.classList.remove("asset-hotspot--firing"), 480);
        // Multi-channel feedback paired with the visual burst:
        //   • Tactile pulse on devices that support Web Vibration
        //   • A synthesized "pop" sound — pairs with the radial ring
        //     so the asset-selected event reads in ear + eye + hand
        haptic(12);
        playSound("pop");
      };
      dot.addEventListener("mouseenter", () => { if (!this._pinned) this._show(it); });
      dot.addEventListener("mouseleave", () => { if (!this._pinned) this._hide(); });

      if (!IS_TOUCH) {
        // Desktop: click toggles the pinned card. (On touch we drive
        // everything from pointer events below — the synthesised `click`
        // is unreliable because the dot moves every frame so pointerdown
        // and pointerup often land on different page coordinates.)
        dot.addEventListener("click", (e) => {
          e.stopPropagation();
          const same = this._pinned === it;
          this._pinned = same ? null : it;
          if (this._pinned) {
            fireBurst();                 // tap-reactivity pulse
            this._show(it);
            this.onAssetSelect?.(it);   // camera fly-to (subscribed in main.js)
          } else {
            this._hide();
          }
        });
      } else {
        // Touch — fully pointer-driven tap detection.
        //
        // Why not `click`? The asset dots are repositioned via CSS
        // transform every frame as the camera moves. A finger that lands
        // on a dot at frame N and lifts at frame N+5 often has its
        // pointerup land on empty space (the dot moved a few px). The
        // browser then fires no `click` because pointerdown / pointerup
        // targets differ — user sees a "ghost tap" with no response.
        // Symptoms: tapping daffodil/grape/statue worked some times and
        // not others.
        //
        // Fix: capture the pointer at pointerdown so all subsequent
        // events route to this element regardless of its on-screen
        // position, and fire the tap action ourselves on pointerup.
        // No long-press gate — every tap (any duration, with <12 px of
        // movement) fires both onAssetSelect (camera fly-to) and
        // onAssetShortTap (mobile-ui opens the asset card in a sheet).
        // The card surface is the same one the desktop hover shows; on
        // mobile it's just routed into a bottom sheet so it doesn't
        // float-block the viewport.
        let pressX = 0, pressY = 0;
        let moved = false;
        let pressActive = false;

        dot.addEventListener("pointerdown", (e) => {
          pressX      = e.clientX;
          pressY      = e.clientY;
          moved       = false;
          pressActive = true;
          // Pointer capture: subsequent events for this gesture stay
          // routed to this dot, even if it transforms away from the
          // finger between pointerdown and pointerup.
          try { dot.setPointerCapture(e.pointerId); } catch {}
        });

        dot.addEventListener("pointermove", (e) => {
          if (!pressActive) return;
          const dx = Math.abs(e.clientX - pressX);
          const dy = Math.abs(e.clientY - pressY);
          if (dx + dy > 12) moved = true;
        });

        const endPress = (e, cancelled = false) => {
          if (!pressActive) return;
          pressActive = false;
          try { dot.releasePointerCapture?.(e.pointerId); } catch {}
          if (cancelled || moved) return;
          e.stopPropagation();
          if (IS_PHONE_MODE) {
            // Phone: every tap = fly + open bottom sheet. The floating
            // hover card is CSS-hidden on .mobile so we don't try to
            // show it; the sheet is the canonical card surface.
            fireBurst();                 // tap-reactivity pulse
            this.onAssetSelect?.(it);
            this.onAssetShortTap?.(it);
          } else {
            // Tablet (or other touch surface without MobileUI): mirror
            // the desktop click — toggle the floating hover card and
            // fly to the asset on first tap. Same UX as PC.
            const same = this._pinned === it;
            this._pinned = same ? null : it;
            if (this._pinned) {
              fireBurst();               // tap-reactivity pulse
              this._show(it);
              this.onAssetSelect?.(it);
            } else {
              this._hide();
            }
          }
        };

        dot.addEventListener("pointerup",     (e) => endPress(e, false));
        dot.addEventListener("pointercancel", (e) => endPress(e, true));
      }

      mountEl.appendChild(dot);
      // Z-flip only — tool exports +Z forward, Three.js wants -Z forward.
      return {
        item:  it,
        el:    dot,
        world: new THREE.Vector3(it.worldPos[0], it.worldPos[1], -it.worldPos[2]),
      };
    });

    this.card = document.createElement("aside");
    this.card.id = "asset-hover-card";
    // .ah-card is the shared "content styling" class — both this
    // floating element and the mobile bottom-sheet wrapper carry it,
    // so the rich card markup (chips, triptych, before/after compare,
    // sim videos, etc.) styles identically on phone and desktop. The
    // #asset-hover-card ID stays for the floating positioning rules
    // (which the sheet wrapper doesn't want).
    this.card.classList.add("ah-card");
    this.card.setAttribute("hidden", "");
    this.card.addEventListener("click", (e) => {
      if (e.target?.dataset?.act === "close") {
        this._pinned = null;
        this._hide();
      }
    });
    mountEl.appendChild(this.card);

    // Click outside the card un-pins.
    document.addEventListener("click", (e) => {
      if (!this._pinned) return;
      if (this.card.contains(e.target)) return;
      if (this.dots.some(d => d.el.contains(e.target))) return;
      this._pinned = null;
      this._hide();
    });

    // Draggable card — pointerdown on the header (anywhere except the
    // close button) starts a drag. Position is persisted across hide /
    // re-show so the user's preferred slot survives switching assets.
    this._cardPos = null;     // { x, y } once the user drags
    this._dragState = null;
    this.card.addEventListener("pointerdown", (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      if (!target.closest(".ah-head")) return;       // only the header is the grab handle
      if (target.closest("[data-act]")) return;      // skip the × button
      const rect = this.card.getBoundingClientRect();
      this._dragState = {
        ox: e.clientX - rect.left,
        oy: e.clientY - rect.top,
        pid: e.pointerId,
      };
      this.card.setPointerCapture?.(e.pointerId);
      this.card.classList.add("dragging");
      e.preventDefault();
    });
    this.card.addEventListener("pointermove", (e) => {
      if (!this._dragState || e.pointerId !== this._dragState.pid) return;
      const x = e.clientX - this._dragState.ox;
      const y = e.clientY - this._dragState.oy;
      this._setCardPos(x, y);
    });
    const endDrag = (e) => {
      if (!this._dragState || (e && e.pointerId !== undefined && e.pointerId !== this._dragState.pid)) return;
      this._dragState = null;
      this.card.classList.remove("dragging");
    };
    this.card.addEventListener("pointerup", endDrag);
    this.card.addEventListener("pointercancel", endDrag);
  }

  // Reserved gutter on the right edge for the rotated mobile bottombar
  // pill (column mode, landscape short viewport). Matches the
  // `margin-right` carved out in style.css. Returns 0 in any other layout.
  _rightGutter() {
    try {
      const landscape = matchMedia("(orientation: landscape) and (max-height: 520px)").matches;
      return landscape ? 88 : 0;
    } catch { return 0; }
  }

  // Pin the card to an explicit (x, y) screen coordinate. Once dragged,
  // the position is remembered so subsequent _show() calls don't snap
  // back to the centered default.
  _setCardPos(x, y) {
    // Clamp into the viewport so the card never escapes off-screen, with
    // an extra gutter on the right in landscape-phone layouts where the
    // bottombar pill is anchored to the right edge.
    const margin = 8;
    const gutter = this._rightGutter();
    const w  = this.card.offsetWidth;
    const h  = this.card.offsetHeight;
    const cx = Math.max(margin, Math.min(window.innerWidth  - w - margin - gutter, x));
    const cy = Math.max(margin, Math.min(window.innerHeight - h - margin, y));
    this._cardPos = { x: cx, y: cy };
    this.card.style.left      = cx + "px";
    this.card.style.top       = cy + "px";
    this.card.style.transform = "none";   // drop the default centering transform
  }

  _show(it) {
    this.card.innerHTML = renderCard(it);
    this.card.removeAttribute("hidden");
    this.card.classList.toggle("pinned", !!this._pinned);
    // Suppress the small floating hotspot labels while the card is
    // showing — the card title already announces the asset, so the
    // additional "Gazebo" / "Daffodil" pills near each dot become
    // redundant and visually fight for the same space.
    document.body.classList.toggle("asset-card-pinned", !!this._pinned);
    // Wire any inline before/after compare widget that's now in the DOM —
    // the .ts-compare CSS already covers visuals; this binds the drag.
    this.card.querySelectorAll(".ts-compare .cmp-frame").forEach(wireCompareFrame);
    // Auto-fit any Vimeo iframes to their clip's actual aspect ratio —
    // removes Vimeo's internal letterbox bars per-video without
    // requiring each embed entry to declare its ratio by hand.
    fitVimeoFrames(this.card);

    // Position the card NEAR the hovered dot (right of it if there's
    // room, otherwise left), instead of pinned to the centre. The old
    // centre layout was right under the asset cluster, so quick mouse
    // moves between adjacent dots flashed the card in/out at the same
    // spot. Anchoring beside the dot makes the card stable visually.
    if (this._cardPos) {
      // User has dragged — honour the parked spot across asset swaps.
      this._setCardPos(this._cardPos.x, this._cardPos.y);
    } else {
      this._anchorCardToDot(it);
    }
  }

  // Place the card next to the dot's current screen position. Tries
  // right, then left; clamps to viewport so it never falls off-screen.
  _anchorCardToDot(it) {
    const dotEntry = this.dots.find(d => d.item === it);
    if (!dotEntry) return;
    const dotRect = dotEntry.el.getBoundingClientRect();
    // Measure the card by rendering off-screen first.
    this.card.style.left      = "-9999px";
    this.card.style.top       = "-9999px";
    this.card.style.transform = "none";
    const w = this.card.offsetWidth  || 600;
    const h = this.card.offsetHeight || 400;
    const gap    = 28;
    const margin = 12;
    const gutter = this._rightGutter();
    // Prefer right of the dot; fall back to left, then a fixed
    // top-right slot if the dot is centered horizontally.
    let x = dotRect.right + gap;
    let y = dotRect.top - 20;
    if (x + w > window.innerWidth - margin - gutter) {
      x = dotRect.left - w - gap;
    }
    if (x < margin) {
      x = Math.max(margin, window.innerWidth - w - margin - gutter);
    }
    y = Math.max(margin, Math.min(window.innerHeight - h - margin, y));
    this.card.style.left = x + "px";
    this.card.style.top  = y + "px";
  }

  _hide() {
    this.card.setAttribute("hidden", "");
    this.card.classList.remove("pinned");
    // Re-show the small floating hotspot labels (suppressed while the
    // card was open — see _show / .asset-card-pinned body class).
    document.body.classList.remove("asset-card-pinned");
  }

  // Public dismissal API — used by external click-outside handlers
  // (the canvas FX click in main.js) to close a pinned card before
  // any click effect fires. Returns true if a card was actually
  // pinned and got dismissed, so the caller can early-return and
  // skip its own action (e.g. the click-FX trigger). Returns false
  // when there's nothing to dismiss, letting the caller fall through
  // to its normal behaviour.
  isPinned() {
    return !!this._pinned;
  }
  dismiss() {
    if (!this._pinned) return false;
    this._pinned = null;
    this._hide();
    return true;
  }

  // Toggle the entire hotspot layer. Used both by the Tech Spec master
  // Enable and by user-uploaded splats (which hide the bundled markers).
  // When turning OFF we explicitly hide every dot; when turning ON we
  // let the per-frame update() loop restore visibility so per-asset
  // _hiddenNames entries stay hidden (no flash on master re-enable).
  setVisible(on) {
    this._visible = !!on;
    if (!on) {
      this._pinned = null;
      this._hide();
      for (const d of this.dots) {
        d.el.style.display = "none";
      }
    }
  }

  // Hide / show a single asset by name. Wired from the Pipeline drawer's
  // per-item ON/OFF toggle so users can declutter the scene for screenshots.
  // The dot itself stays hidden via the _hiddenNames check in update().
  setItemVisible(name, on) {
    if (on) this._hiddenNames.delete(name);
    else    this._hiddenNames.add(name);
    if (!on && this._pinned?.name === name) {
      this._pinned = null;
      this._hide();
    }
  }

  // Call once per frame after the camera matrices are current.
  update() {
    if (!this._visible || !this.camera || !this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    for (const d of this.dots) {
      // Per-asset toggle from the Pipeline drawer wins over the projection
      // logic — if hidden, skip the math entirely.
      if (this._hiddenNames.has(d.item.name)) {
        d.el.style.display = "none";
        continue;
      }
      _v.copy(d.world).project(this.camera);
      const offscreen = _v.z > 1 || _v.x < -1.1 || _v.x > 1.1 || _v.y < -1.1 || _v.y > 1.1;
      if (offscreen) {
        d.el.style.display = "none";
        continue;
      }
      d.el.style.display = "flex";
      const x = rect.left + (_v.x * 0.5 + 0.5) * rect.width;
      const y = rect.top  + (1 - (_v.y * 0.5 + 0.5)) * rect.height;
      d.el.style.transform = `translate(${x}px, ${y}px)`;
    }
  }
}
