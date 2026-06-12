// ---------------------------------------------------------------------------
// Credits — centered floating panel listing team members and the software
// stack used in the showcase. Toggled by the "Credits" checkbox under the
// Tech Spec folder in lil-gui. Each team member row carries a small
// external-link icon — wire the URL via TEAM[i].url when known, leave
// "#" as a placeholder and the icon stays dim / non-clickable.
// ---------------------------------------------------------------------------

const TEAM = [
  { name: "Danci Shen",               role: "Team Member", url: "https://omolism.cargo.site/" },
  { name: "Itim Kongsakulvatanasook", role: "Team Member", url: "https://itimkongs.com" },
  { name: "Yiqi Zheng",               role: "Team Member", url: "https://yiqizheng.wixsite.com/yiqizheng" },
  { name: "Yiyi Long",                role: "Team Member", url: "https://yiyilongart.wixsite.com/portfolio" },
  { name: "Yichen Shi",               role: "Team Member", url: "https://yichenshi.wixstudio.com/index" },
  { name: "Ben Jones",                role: "Team Member", url: "https://www.benjvisuals.com" },
  { name: "Xinyi Liang",              role: "Team Member", url: "https://www.artstation.com/xiaoduye817" },
];

// Supervising Professor — split out of Special Thanks so the advisory
// role reads as its own distinct credit weight rather than being
// flattened in with the rest of the thanks. Same row markup as
// SPECIAL_THANKS so the visual styling stays consistent.
const SUPERVISING_PROFESSOR = [
  { name: "Dr. Deborah R. Fowler", url: "https://www.deborahrfowler.com/" },
];

// Special Thanks — advisors, mentors, external teams. Distinct from the
// team list so credit weight reads correctly.
const SPECIAL_THANKS = [
  { name: "Munkhtsetseg Nandigjav",            url: "https://www.linkedin.com/in/munkhtsetseg-nandigjav" },
  { name: "Erin O'Leary",                      url: "https://www.linkedin.com/in/erinleeoleary/" },
  { name: "NVIDIA Omniverse and OpenUSD team", url: "https://www.linkedin.com/showcase/nvidia-omniverse/" },
  { name: "SideFX",                            url: "https://www.sidefx.com/" },
];

// Software — commercial / production DCC tools the team authored in.
// Unreal Engine and Houdini are the hero entries (top of the section,
// highlighted via .cr-chip-featured). SpeedTree was used minimally
// (a single asset class) and per user direction is now demoted out of
// the chip row entirely into the small SOFTWARE_ALSO footnote rendered
// below the chip grid — keeps the credit honest without granting it
// equal billboard space alongside the production-heavy tools.
const SOFTWARE_FEATURED = ["Unreal Engine", "Houdini"];
const SOFTWARE_OTHER    = [
  "Postshot", "Perforce", "Lichtfeld Studio",
];
const SOFTWARE_ALSO     = ["SpeedTree"];

// Tech Stack — the research / runtime / interop methods that ride
// underneath the visible scene. HP AI Studio and OpenUSD are the
// featured story beats.
const TECH_FEATURED = ["HP AI Studio", "OpenUSD"];
const TECH_OTHER    = [
  // Reconstruction
  "COLMAP",
  // AI stylization
  "PyTorch", "CUDA", "IP-Adapter", "ControlNet", "AdaIN",
  // Render runtime
  "@sparkjsdev/spark", "Three.js", "WebGL 2", "Vite",
  // Interaction
  "MediaPipe HandLandmarker",
  // USD primitives
  "UsdGeomPointInstancer",
];

const LINK_ICON_SVG = `
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M9 2h5v5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M14 2L7.5 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

export class Credits {
  constructor({ mountEl = document.body } = {}) {
    this.open = false;

    this.el = document.createElement("aside");
    this.el.id = "credits";
    this.el.innerHTML = `
      <header class="cr-head">
        <span class="cr-title">ABOUT &middot; CREDITS</span>
        <button class="cr-close" data-act="close" title="Close">&times;</button>
      </header>
      <div class="cr-body">
        <!-- About / project-level context. Mirrors the loading-splash +
             cinematic-flourish wordmark vocabulary so the panel reads as
             the "this is the project" surface. Added per PM-6 review:
             the page previously had no project-level "what am I looking
             at" anywhere — only per-asset detail in the Tech Spec. -->
        <section class="cr-sec cr-about">
          <div class="cr-about-eyebrow">A 3D Gaussian Splatting showcase</div>
          <h2 class="cr-about-title">SplatGarden</h2>
          <div class="cr-about-sub">Studio Showcase</div>
          <div class="cr-about-stack">Houdini &middot; Unreal &middot; COLMAP &middot; Spark</div>
        </section>
        <section class="cr-sec">
          <div class="cr-sec-title">Team</div>
          <ul class="cr-list">
            ${TEAM.map(p => {
              const linked = p.url && p.url !== "#";
              const aOpen  = linked
                ? `<a class="cr-link" href="${p.url}" target="_blank" rel="noopener noreferrer" title="Open ${p.name}'s site">`
                : `<span class="cr-link cr-link-empty" title="No link yet">`;
              const aClose = linked ? `</a>` : `</span>`;
              return `
                <li class="cr-row">
                  <span class="cr-name">${p.name}</span>
                  <span class="cr-role">${p.role}</span>
                  ${aOpen}${LINK_ICON_SVG}${aClose}
                </li>`;
            }).join("")}
          </ul>
        </section>
        <section class="cr-sec">
          <div class="cr-sec-title">Supervising Professor</div>
          <ul class="cr-list cr-list-thanks">
            ${SUPERVISING_PROFESSOR.map(p => {
              const linked = p.url && p.url !== "#";
              const aOpen  = linked
                ? `<a class="cr-link" href="${p.url}" target="_blank" rel="noopener noreferrer" title="Open ${p.name}'s site">`
                : `<span class="cr-link cr-link-empty" title="No link yet">`;
              const aClose = linked ? `</a>` : `</span>`;
              return `
                <li class="cr-row cr-row-thanks">
                  <span class="cr-name">${p.name}</span>
                  ${aOpen}${LINK_ICON_SVG}${aClose}
                </li>`;
            }).join("")}
          </ul>
        </section>
        <section class="cr-sec">
          <div class="cr-sec-title">Special Thanks</div>
          <ul class="cr-list cr-list-thanks">
            ${SPECIAL_THANKS.map(p => {
              const linked = p.url && p.url !== "#";
              const aOpen  = linked
                ? `<a class="cr-link" href="${p.url}" target="_blank" rel="noopener noreferrer" title="Open ${p.name}'s page">`
                : `<span class="cr-link cr-link-empty" title="No link yet">`;
              const aClose = linked ? `</a>` : `</span>`;
              return `
                <li class="cr-row cr-row-thanks">
                  <span class="cr-name">${p.name}</span>
                  ${aOpen}${LINK_ICON_SVG}${aClose}
                </li>`;
            }).join("")}
          </ul>
        </section>
        <section class="cr-sec">
          <div class="cr-sec-title">Software</div>
          <div class="cr-chips">
            ${SOFTWARE_FEATURED.map(s => `<span class="cr-chip cr-chip-featured">${s}</span>`).join("")}
            ${SOFTWARE_OTHER   .map(s => `<span class="cr-chip">${s}</span>`).join("")}
          </div>
          ${SOFTWARE_ALSO.length ? `<div class="cr-also">Also: ${SOFTWARE_ALSO.join(" &middot; ")}</div>` : ""}
        </section>
        <section class="cr-sec">
          <div class="cr-sec-title">Tech Stack</div>
          <div class="cr-chips">
            ${TECH_FEATURED.map(s => `<span class="cr-chip cr-chip-featured">${s}</span>`).join("")}
            ${TECH_OTHER   .map(s => `<span class="cr-chip">${s}</span>`).join("")}
          </div>
        </section>
        <!-- Sponsor thanks — two stacked lines, each calling out a
             SPECIFIC kind of support (compute hardware via NVIDIA;
             Houdini access via SideFX). Kept as small mono footer
             type so they read as quiet acknowledgements parallel
             to each other, NOT as featured chips up in the SOFTWARE
             stack above. The wrapper carries the top border + shared
             typography; the inner divs stack with a tight gap. -->
        <div class="cr-hw-thanks">
          <div>Rendered on <strong>NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition</strong>. Sincere thanks to NVIDIA.</div>
          <div>Houdini access generously supported by <strong>SideFX</strong>. Thank you for the partnership.</div>
        </div>
      </div>
    `;
    mountEl.appendChild(this.el);

    this.el.querySelector('[data-act="close"]').addEventListener("click", () => this.close());

    window.addEventListener("keydown", (e) => {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      if (e.key === "Escape" && this.open) { e.preventDefault(); this.close(); }
    });

    // Draggable from the header. Once dragged, the panel detaches from the
    // CSS centering transform and is positioned by absolute left/top; the
    // chosen spot is remembered for subsequent show() calls so users don't
    // lose their preferred slot when they reopen Credits.
    this._panelPos  = null;
    this._dragState = null;
    this.el.addEventListener("pointerdown", (e) => {
      const target = e.target;
      if (!target?.closest?.(".cr-head")) return;          // header is the grab handle
      if (target.closest?.("[data-act]"))  return;          // skip the × button
      const rect = this.el.getBoundingClientRect();
      this._dragState = {
        ox: e.clientX - rect.left,
        oy: e.clientY - rect.top,
        pid: e.pointerId,
      };
      // Pin to the current rect so transform-centering doesn't snap the
      // panel mid-drag — every subsequent move uses absolute coords.
      this._setPanelPos(rect.left, rect.top);
      this.el.setPointerCapture?.(e.pointerId);
      this.el.classList.add("dragging");
      e.preventDefault();
    });
    this.el.addEventListener("pointermove", (e) => {
      if (!this._dragState || e.pointerId !== this._dragState.pid) return;
      this._setPanelPos(e.clientX - this._dragState.ox, e.clientY - this._dragState.oy);
    });
    const endDrag = (e) => {
      if (!this._dragState || (e?.pointerId !== undefined && e.pointerId !== this._dragState.pid)) return;
      this._dragState = null;
      this.el.classList.remove("dragging");
    };
    this.el.addEventListener("pointerup",     endDrag);
    this.el.addEventListener("pointercancel", endDrag);

    // Click outside the panel closes it. Captures pointerdown so the dismiss
    // fires before any other click handler downstream. Skips clicks on
    // lil-gui (the Credits checkbox lives there — let lil-gui's own
    // onChange path handle that toggle) so the checkbox doesn't fight
    // this listener and re-open immediately.
    this._onOutsidePointerDown = (e) => {
      if (!this.open) return;
      if (this.el.contains(e.target)) return;
      if (e.target?.closest?.('.lil-gui')) return;
      this.close();
    };
  }

  show()  {
    this.open = true;
    this.el.classList.add("show");
    // Re-apply the user's last drag position if there is one — otherwise
    // the CSS transform centering kicks back in for first-time opens.
    if (this._panelPos) this._setPanelPos(this._panelPos.x, this._panelPos.y);
    this.onOpenChange?.(true);
    // Defer attaching the outside-click listener one tick so the click
    // that opened us doesn't immediately close us.
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
  toggle()  { this.open ? this.close() : this.show(); }
  setOpen(v){ v ? this.show() : this.close(); }

  // Pin the panel to an absolute viewport coordinate, clamped so it can't
  // escape off-screen. Drops the CSS transform centering on first call.
  _setPanelPos(x, y) {
    const margin = 8;
    const w  = this.el.offsetWidth;
    const h  = this.el.offsetHeight;
    const cx = Math.max(margin, Math.min(window.innerWidth  - w - margin, x));
    const cy = Math.max(margin, Math.min(window.innerHeight - h - margin, y));
    this._panelPos = { x: cx, y: cy };
    this.el.style.left      = cx + "px";
    this.el.style.top       = cy + "px";
    this.el.style.transform = "none";
  }
}
