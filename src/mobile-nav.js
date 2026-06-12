// ---------------------------------------------------------------------------
// MobileNav — top-right hamburger menu that surfaces the keyboard-shortcut
// panels (Pipeline T / Viewport Tuner K / Quick Guide H / Profiler P /
// Credits) on touch devices that have no physical keyboard.
//
// Hidden on desktop via CSS (body:not(.touch)). Each menu item calls the
// existing .toggle() on the matching panel — there is no parallel state
// machine, just a touch-friendly entry point.
// ---------------------------------------------------------------------------

// Lucide-style 24×24 line icons with stroke=currentColor so they inherit
// .mn-icon's text color. Stroke 1.6 reads crisp at the 22 px rendered
// size; rounded caps + joins avoid pixel rough edges on phone DPI.
const HAMBURGER_SVG = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="4" y1="7"  x2="20" y2="7" />
    <line x1="4" y1="12" x2="20" y2="12"/>
    <line x1="4" y1="17" x2="20" y2="17"/>
  </svg>`;

const CLOSE_SVG = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="6"  y1="6" x2="18" y2="18"/>
    <line x1="18" y1="6" x2="6"  y2="18"/>
  </svg>`;

// Per-row icons — each one a single SVG string slotted into the .mn-icon
// span. Replaces the previous unicode glyphs (▦ ? ▤ ★ ↻) which rendered
// inconsistently across platforms (especially the star — different shape
// on iOS vs. Android). Inline SVG gives crisp 1× / 2× / 3× rendering.
const ICON = {
  pipeline: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3.5"  y="3.5"  width="7" height="7" rx="1.2"/>
      <rect x="13.5" y="3.5"  width="7" height="7" rx="1.2"/>
      <rect x="3.5"  y="13.5" width="7" height="7" rx="1.2"/>
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.2"/>
    </svg>`,
  quickGuide: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <path d="M9.4 9.2c.2-1.7 1.4-2.7 2.8-2.7 1.5 0 2.8 1 2.8 2.4 0 1.4-1.1 2-2 2.5-.8.4-1 1-1 1.6"/>
      <line x1="12" y1="16.6" x2="12" y2="16.6"/>
    </svg>`,
  profiler: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <line x1="5"  y1="20" x2="5"  y2="13"/>
      <line x1="10" y1="20" x2="10" y2="8"/>
      <line x1="15" y1="20" x2="15" y2="11"/>
      <line x1="20" y1="20" x2="20" y2="4"/>
    </svg>`,
  credits: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="12 3 14.7 9.3 21.5 9.9 16.3 14.4 17.9 21 12 17.5 6.1 21 7.7 14.4 2.5 9.9 9.3 9.3"/>
    </svg>`,
  replay: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="2.5 5.5 2.5 10.5 7.5 10.5"/>
      <path d="M4.2 12.6a8.5 8.5 0 1 0 2-6.4"/>
    </svg>`,
};

// Lazy resolver — viewpointTuner is created inside loadSplat() after the
// MobileNav constructor runs, so we look refs up on click via the
// window.__* exposes that main.js already publishes. Anything that's not
// yet constructed becomes a no-op until it is.
const RESOLVE = {
  techSpec:       () => window.__techSpec,
  viewpointTuner: () => window.__viewpointTuner,
  keyHints:       () => window.__keyHints,
  profiler:       () => window.__profiler,
  credits:        () => window.__credits,
};

export class MobileNav {
  constructor() {
    this.open = false;
    this._build();
  }

  _build() {
    // Trigger button — fixed top-right corner.
    this.btn = document.createElement("button");
    this.btn.id = "mobile-nav-btn";
    this.btn.setAttribute("aria-label", "Open navigation");
    this.btn.setAttribute("aria-expanded", "false");
    this.btn.innerHTML = HAMBURGER_SVG;
    this.btn.addEventListener("click", () => this.toggle());
    document.body.appendChild(this.btn);

    // Drawer — slides down from the top-right corner. Each item resolves
    // its panel at click time so we tolerate refs being null (which can
    // happen if a future panel is removed without updating MobileNav).
    this.menu = document.createElement("aside");
    this.menu.id = "mobile-nav-menu";
    this.menu.setAttribute("hidden", "");
    // Hamburger is intentionally empty now — every surface that used to
    // live here has been promoted into the bottom-bar / its sheets:
    //   Pipeline → Info sheet's "Open Pipeline" button
    //   Profiler → not surfaced on touch (dev-only; reach via console
    //              `window.__profiler.toggle()` if needed)
    //   Quick Guide, Credits, Replay Intro → Info / Camera sheets
    // The button itself is also hidden on body.touch via CSS, so this
    // empty menu never actually paints. The class is kept (instead of
    // outright deleted) so a future re-add is one-line.
    this.menu.innerHTML = `<ul class="mn-list"></ul>`;
    document.body.appendChild(this.menu);

    this.menu.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("button[data-target]");
      if (!btn) return;
      const key = btn.dataset.target;
      // Replay isn't a panel — it's a one-shot action that reloads.
      if (key === "replay") {
        window.__replayIntro?.();
        return;
      }
      const panel = RESOLVE[key]?.();
      if (!panel) return;
      // Each panel has its own toggle method; some use showFor for auto-
      // hiding cards (Quick Guide). Prefer toggle when present.
      if (typeof panel.toggle === "function") panel.toggle();
      else if (typeof panel.showFor === "function") panel.showFor(6500);
      this.close();
    });

    // Close when the user taps outside the drawer or the trigger.
    document.addEventListener("pointerdown", (e) => {
      if (!this.open) return;
      if (this.menu.contains(e.target)) return;
      if (this.btn .contains(e.target)) return;
      this.close();
    }, true);
  }

  open_()   { this.open = true;  this.menu.removeAttribute("hidden"); this.btn.innerHTML = CLOSE_SVG;    this.btn.setAttribute("aria-expanded", "true"); }
  close()   { this.open = false; this.menu.setAttribute("hidden", ""); this.btn.innerHTML = HAMBURGER_SVG; this.btn.setAttribute("aria-expanded", "false"); }
  toggle()  { this.open ? this.close() : this.open_(); }
}
