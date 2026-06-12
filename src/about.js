// ---------------------------------------------------------------------------
// About — a dedicated project-narrative panel separate from Credits.
//
// Credits stays as-is (team / thanks / software / tech-stack / hardware
// footer). This module adds the "what is this project actually about?"
// surface — the four-pillar framing (AI Tools / 3DGS / Simulation /
// Interaction under Real-Time Visual + Simulation), a one-line slice of
// each pillar, and two outbound CTAs (Tech Spec deep-dive + GitHub).
//
// The trigger is a prominent floating pill at the top-centre of the
// viewport, deliberately MORE visible than the small "About" link in
// the bottom toolbar — visitors should reach this within the first few
// seconds of the page, not after they've explored the lil-gui.
//
// Toggle: click the floating pill, click again to close, Esc to close,
// outside-tap to close. Tech Spec link delegates to window.__techSpec
// (instantiated separately in main.js — keep them loosely coupled).
// ---------------------------------------------------------------------------

const PILLARS = [
  {
    tag: "AI Tools",
    line: "Custom diffusion-based texture stylization · IP-Adapter · ControlNet · AdaIN",
  },
  {
    tag: "3DGS",
    line: "~3M splats from a Postshot capture, rendered via Spark with OpenUSD subforms",
  },
  {
    tag: "Simulation",
    line: "Houdini-driven gazebo SIM · VAT-baked daffodil · Unreal WPO vine growth",
  },
  {
    tag: "Interaction",
    line: "MediaPipe hand tracking · GPGPU click FX · live Python · OSC rigs in Unreal",
  },
];

export class About {
  constructor({ mountEl = document.body, onOpenTechSpec = null, onOpenCredits = null } = {}) {
    this.open = false;
    this.onOpenTechSpec = onOpenTechSpec;
    this.onOpenCredits  = onOpenCredits;

    // --- Trigger button (top-centre floating pill) ---
    this.btn = document.createElement("button");
    this.btn.id = "about-trigger";
    this.btn.type = "button";
    this.btn.setAttribute("aria-haspopup", "dialog");
    this.btn.setAttribute("aria-expanded", "false");
    this.btn.setAttribute("aria-label", "About this project");
    this.btn.innerHTML = `
      <span class="ab-trig-dot" aria-hidden="true"></span>
      <span class="ab-trig-label">About this project</span>
      <span class="ab-trig-arrow" aria-hidden="true">→</span>
    `;
    this.btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggle();
    });
    mountEl.appendChild(this.btn);

    // --- Panel ---
    this.el = document.createElement("aside");
    this.el.id = "about-panel";
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-modal", "false");
    this.el.setAttribute("aria-label", "About SplatGarden");
    this.el.setAttribute("hidden", "");
    this.el.innerHTML = `
      <header class="ab-head">
        <span class="ab-title">About this project</span>
        <button class="ab-close" data-act="close" type="button" aria-label="Close">&times;</button>
      </header>
      <div class="ab-body">
        <section class="ab-hero">
          <div class="ab-eyebrow">Real-Time Visual + Simulation</div>
          <h2 class="ab-name">SplatGarden</h2>
          <p class="ab-blurb">
            The project spans four pillars: <strong>AI Tools</strong>,
            <strong>3DGS</strong>, <strong>Simulation</strong>, and live
            <strong>Interaction</strong>, all under the theme
            <em>Real-Time Visual and Simulation</em>. This browser viewer
            is the web-deployable face of that work. It captures an
            Unreal Engine garden as a 3D Gaussian Splat, authored with
            custom AI-stylized textures and dressed with Houdini-driven
            simulations, then re-renders the scene live with hand-tracking
            interaction. The same garden is staged on an LED volume for
            large-screen display; this viewer is the portable counterpart
            that ships in a browser tab.
          </p>
        </section>

        <section class="ab-pillars-sec">
          <div class="ab-sec-title">Pipeline</div>
          <ul class="ab-pillars">
            ${PILLARS.map(p => `
              <li class="ab-pillar">
                <span class="ab-pillar-tag">${p.tag}</span>
                <span class="ab-pillar-line">${p.line}</span>
              </li>
            `).join("")}
          </ul>
        </section>
      </div>

      <!-- CTAs live OUTSIDE .ab-body so they pin to the bottom of the
           panel via flex layout. On short viewports the scrollable body
           may not show everything at once, but the two action buttons
           stay visible without scrolling — they're the only path
           forward from this surface. -->
      <section class="ab-cta-sec">
        <button class="ab-cta" data-act="open-tech-spec" type="button">
          <span class="ab-cta-label">Read the full Tech Spec</span>
          <span class="ab-cta-arrow" aria-hidden="true">→</span>
        </button>
        <button class="ab-cta" data-act="open-credits" type="button">
          <span class="ab-cta-label">Team &middot; Credits &middot; Software</span>
          <span class="ab-cta-arrow" aria-hidden="true">→</span>
        </button>
      </section>
    `;
    mountEl.appendChild(this.el);

    this.el.querySelector('[data-act="close"]')
      ?.addEventListener("click", () => this.close());

    this.el.querySelector('[data-act="open-tech-spec"]')
      ?.addEventListener("click", () => {
        // CLOSE About before opening Tech Spec — the original stacked-
        // modal idea (About stays open behind Tech Spec) read as two
        // competing panels with no clear focus, especially on phone
        // portrait where the new top-anchored About + centred Tech Spec
        // visibly overlapped. Single panel at a time = clear focus +
        // simple back-out (X returns to the scene; trigger re-opens
        // About in one tap).
        this.close();
        if (typeof this.onOpenTechSpec === "function") this.onOpenTechSpec();
        else if (window.__techSpec?.openOverlay) window.__techSpec.openOverlay();
      });

    this.el.querySelector('[data-act="open-credits"]')
      ?.addEventListener("click", () => {
        // Same as Tech Spec — close About, then open Credits. No more
        // stacked-modal overlap visible in the screenshots.
        this.close();
        if (typeof this.onOpenCredits === "function") this.onOpenCredits();
        else if (window.__credits?.setOpen) window.__credits.setOpen(true);
      });

    // Esc closes; outside-tap closes. Both run in capture so they fire
    // before deeper handlers (similar to Credits' dismiss pattern).
    window.addEventListener("keydown", (e) => {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      if (e.key === "Escape" && this.open) { e.preventDefault(); this.close(); }
    });

    this._onOutside = (e) => {
      if (!this.open) return;
      if (this.el.contains(e.target)) return;
      if (this.btn.contains(e.target)) return;
      // Don't fight Tech Spec / Credits — clicking their surfaces should
      // not close About immediately. Their own outside-handlers manage
      // their own dismiss; About just stays out of their way.
      if (e.target?.closest?.('#tech-spec, #credits, .lil-gui')) return;
      this.close();
    };
  }

  toggle() { this.open ? this.close() : this.show(); }

  show() {
    this.open = true;
    this.el.removeAttribute("hidden");
    // Force a reflow with display:flex applied AND defer the .show class
    // to the next animation frame. Without the rAF gap, Chrome batches
    // the display:none → display:flex + .show transition into a single
    // paint and skips the opacity / transform animation entirely
    // (the element jumps straight to the end state — except in our case
    // it visibly stayed in the BASE state instead, because Chrome was
    // also treating the just-set display as "no previous frame to
    // interpolate from").
    void this.el.offsetHeight;
    // setTimeout(0) (not rAF) so the class flips even when the tab is
    // backgrounded and rAF is paused. The 1-tick delay still gives the
    // display:flex paint a chance to commit before .show triggers the
    // transition.
    setTimeout(() => {
      if (!this.open) return;
      this.el.classList.add("show");
      this.btn.classList.add("active");
      this.btn.setAttribute("aria-expanded", "true");
    }, 0);
    // Defer the outside-tap listener one tick so the click that opened
    // us doesn't immediately close us.
    setTimeout(() => {
      if (this.open) document.addEventListener("pointerdown", this._onOutside, true);
    }, 0);
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.el.classList.remove("show");
    this.btn.classList.remove("active");
    this.btn.setAttribute("aria-expanded", "false");
    // Hide AFTER the fade-out transition so it doesn't pop visually.
    setTimeout(() => {
      if (!this.open) this.el.setAttribute("hidden", "");
    }, 220);
    document.removeEventListener("pointerdown", this._onOutside, true);
  }
}
