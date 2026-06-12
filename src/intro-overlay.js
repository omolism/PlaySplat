// ---------------------------------------------------------------------------
// IntroOverlay — title-sequence text layered over the auto-playing camera
// move. Two strata:
//
//   * Hero title       — big centered text in the opening ~3.5 s
//   * Phase callouts   — lower-third bars at each ¼ marker of the clip,
//                        in sync with the existing 4-phase subform schedule
//
// Driven by an externally supplied clip-time. Call .update(tNorm, playing)
// once per frame; tNorm is 0..1 across the clip, `playing` flips false at
// finish so the overlay can clear itself. Show() arms the overlay for the
// next play cycle; the manager auto-hides everything after the clip ends.
// ---------------------------------------------------------------------------

// Hero: fades in immediately, holds, fades out before the first phase
// callout takes over. Times are in clip-normalized [0..1] units. The clip
// is the middle-400-frame subclip of Shot4B (~16.67 s).
const HERO = {
  text:    "SplatGarden",
  sub:     "A 3D Gaussian Splatting asset showcase",
  inAt:    0.005,
  holdTo:  0.13,
  outAt:   0.17,
};

// Lower-third callouts: one per ¼ of the clip. eyebrow names the phase,
// text describes the step concretely (tool + scale where useful). No
// decorative separators in the copy — commas only.
const PHASES = [
  { at: 0.02, until: 0.25, eyebrow: "CAPTURE", text: "Captured in Unreal Engine" },
  { at: 0.27, until: 0.50, eyebrow: "POSE",    text: "990 camera poses solved with COLMAP" },
  { at: 0.52, until: 0.75, eyebrow: "TRAIN",   text: "3 million Gaussians optimized in Postshot" },
  { at: 0.77, until: 0.99, eyebrow: "RENDER",  text: "Real-time WebGL playback via Spark" },
];

// Smooth fade window around each boundary, in clip-normalized units.
const FADE = 0.025;

// Smoothstep
const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };

export class IntroOverlay {
  constructor({ mountEl = document.body } = {}) {
    this.el = document.createElement("div");
    this.el.id = "intro-overlay";
    this.el.setAttribute("hidden", "");
    this.el.innerHTML = `
      <div class="io-hero" data-k="hero">
        <div class="io-hero-title">${HERO.text}</div>
        <div class="io-hero-sub">${HERO.sub}</div>
      </div>
      <div class="io-phase" data-k="phase">
        <div class="io-phase-eyebrow" data-k="eyebrow"></div>
        <div class="io-phase-text"    data-k="text"></div>
      </div>
      <div class="io-bottom-bar" data-k="bar"><div class="io-bottom-fill" data-k="fill"></div></div>
    `;
    mountEl.appendChild(this.el);

    this.heroEl    = this.el.querySelector('[data-k="hero"]');
    this.phaseEl   = this.el.querySelector('[data-k="phase"]');
    this.eyebrowEl = this.el.querySelector('[data-k="eyebrow"]');
    this.textEl    = this.el.querySelector('[data-k="text"]');
    this.fillEl    = this.el.querySelector('[data-k="fill"]');

    this._currentPhase = -1;
  }

  show() {
    this.el.removeAttribute("hidden");
    this._currentPhase = -1;
    // Force a reflow so the CSS transition picks up the first set of
    // opacities cleanly the next frame.
    void this.el.offsetHeight;
  }

  hide() {
    this.el.setAttribute("hidden", "");
    this.heroEl.style.opacity = "0";
    this.phaseEl.style.opacity = "0";
    this.fillEl.style.width = "0%";
  }

  // tNorm: clip progress 0..1. playing: false once the AnimationMixer's
  // 'finished' fires.
  update(tNorm, playing) {
    if (!playing) { this.hide(); return; }

    // Hero opacity envelope: ramp up at inAt, hold to holdTo, ramp down at
    // outAt. Anything past outAt + FADE is 0.
    let heroAlpha = 0;
    if (tNorm < HERO.inAt) heroAlpha = 0;
    else if (tNorm < HERO.holdTo) heroAlpha = smooth((tNorm - HERO.inAt) / FADE);
    else if (tNorm < HERO.outAt)  heroAlpha = 1;
    else                          heroAlpha = 1 - smooth((tNorm - HERO.outAt) / FADE);
    heroAlpha = Math.max(0, Math.min(1, heroAlpha));
    this.heroEl.style.opacity = heroAlpha.toFixed(3);

    // Find the active phase. Each phase is [at, until]. The fade window
    // FADE is symmetric around each boundary so we always cross-fade.
    let activeIdx = -1;
    let phaseAlpha = 0;
    for (let i = 0; i < PHASES.length; i++) {
      const p = PHASES[i];
      if (tNorm >= p.at - FADE && tNorm <= p.until + FADE) {
        activeIdx = i;
        if (tNorm < p.at) {
          phaseAlpha = smooth((tNorm - (p.at - FADE)) / FADE);
        } else if (tNorm > p.until) {
          phaseAlpha = 1 - smooth((tNorm - p.until) / FADE);
        } else {
          phaseAlpha = 1;
        }
        break;
      }
    }
    if (activeIdx !== this._currentPhase && activeIdx >= 0) {
      this._currentPhase = activeIdx;
      this.eyebrowEl.textContent = PHASES[activeIdx].eyebrow;
      this.textEl.textContent    = PHASES[activeIdx].text;
    }
    this.phaseEl.style.opacity = phaseAlpha.toFixed(3);

    // Progress strip across the bottom edge — purely decorative chrome.
    this.fillEl.style.width = (tNorm * 100).toFixed(2) + "%";
  }
}
