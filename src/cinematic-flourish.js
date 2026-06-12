// ---------------------------------------------------------------------------
// cinematic-flourish.js — end-of-cinematic title card. Fires when the FBX
// camera-move mixer emits "finished", overlaying a brief "SplatGarden"
// signature card so the cinematic feels authored to its conclusion
// rather than just stopping.
//
// Typography mirrors the LOADING SPLASH exactly (same .ld-title /
// .ld-sub / .ld-rule recipe under different class names) so the
// opening + closing bookends of the user journey are typographically
// continuous. No all-caps on the hero title, no letter-spacing
// gymnastics, no scale-on-exit. Just an opacity fade — the natural
// idiom for a single film-style end card.
//
// Timing:
//   0    – 700 ms   opacity fade-in
//   700  – 2400 ms  hold (no animation; the card is still)
//   2400 – 3100 ms  opacity fade-out
//
// Self-cleaning: the DOM element is torn down at the end of the fade-
// out so a subsequent Replay-intro mounts a fresh card. Idempotent —
// calling play() while already mid-show is a no-op.
// ---------------------------------------------------------------------------

const TIMING = {
  fadeInMs:  700,
  holdMs:   1700,
  fadeOutMs: 700,
};

export class CinematicFlourish {
  constructor({ mountEl = document.body, title = "SplatGarden", subtitle = "Studio Showcase", credit = "Houdini · SpeedTree · Unreal · COLMAP · Spark" } = {}) {
    this.mountEl  = mountEl;
    this.title    = title;
    this.subtitle = subtitle;
    this.credit   = credit;
    this._active  = false;
    this._el      = null;
  }

  /**
   * Show the flourish. Returns a promise that resolves when the full
   * sequence (fade-in + hold + fade-out + cleanup) completes. No-op if
   * a previous play() is still mid-sequence.
   */
  play() {
    if (this._active) return Promise.resolve();
    this._active = true;

    // Build the card on demand so the DOM stays clean between cinematics.
    // Structure mirrors the loading splash (.ld-title → .ld-sub → .ld-rule
    // → .ld-desc) so the closing card reads as the typographic sibling of
    // the opening one — same hero word, same hairline, same mono caption.
    const el = document.createElement("div");
    el.className = "cinematic-flourish";
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = `
      <div class="cf-stack">
        <h2 class="cf-title">${this.title}</h2>
        <div class="cf-sub">${this.subtitle}</div>
        <div class="cf-rule" aria-hidden="true"></div>
        <div class="cf-credit">${this.credit}</div>
      </div>
    `;
    this.mountEl.appendChild(el);
    this._el = el;

    // Force a reflow before adding the .show class so the fade-in
    // transition fires reliably (otherwise the browser may collapse
    // the initial → final state into the same frame).
    void el.offsetHeight;
    el.classList.add("show");

    const total = TIMING.fadeInMs + TIMING.holdMs + TIMING.fadeOutMs;

    return new Promise((resolve) => {
      setTimeout(() => {
        if (!el.parentNode) return resolve();    // disposed early
        el.classList.add("fade-out");
        setTimeout(() => {
          this._cleanup();
          resolve();
        }, TIMING.fadeOutMs + 50);                // +50 ms cushion for the transition
      }, TIMING.fadeInMs + TIMING.holdMs);
    });
  }

  /**
   * Cancel any in-flight flourish and remove the DOM element. Safe to
   * call multiple times; called automatically at the end of play().
   */
  dispose() { this._cleanup(); }

  _cleanup() {
    if (this._el?.parentNode) this._el.parentNode.removeChild(this._el);
    this._el = null;
    this._active = false;
  }
}
