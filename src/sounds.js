// ---------------------------------------------------------------------------
// sounds.js — synthesized Web Audio micro-feedback for the UI.
//
// Why synthesized rather than sample files: each clip is ~50–250 ms, the
// envelopes are simple, and we don't want to ship 3 more network round-trips
// just for tics + whooshes. The whole module is ≈ 150 LOC + zero bytes of
// extra asset payload. Browsers require a user gesture before AudioContext
// can start, so the context is created lazily on first call; everything
// before that is a clean no-op.
//
// Public API:
//   playSound("tic")     → toggle / pill click / viewpoint snap
//   playSound("whoosh")  → camera fly-to
//   playSound("pop")     → asset selected / hotspot tap
//   playSound("rise")    → bottom-bar tab / sheet opens
//   setSoundEnabled(on)  → master switch (future Settings hook)
//
// All sounds are designed to be PERCUSSIVE — short envelope, low energy,
// no sustain. They land as punctuation, not as a noticeable layer. If you
// can hum them after hearing them once, they're too loud.
// ---------------------------------------------------------------------------

let _enabled = true;
let _ctx = null;            // AudioContext, lazy
let _master = null;         // master gain — global volume + mute
const MASTER_GAIN = 0.18;   // conservative; bump if too quiet under real-world chatter

function _ensureCtx() {
  if (_ctx) return _ctx;
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    _ctx = new AC();
    _master = _ctx.createGain();
    _master.gain.value = MASTER_GAIN;
    _master.connect(_ctx.destination);
  } catch {
    _ctx = null;
  }
  return _ctx;
}

/** Resume the context if it's suspended (Safari often suspends on tab switch). */
function _resume() {
  if (_ctx && _ctx.state === "suspended") {
    try { _ctx.resume(); } catch {}
  }
}

// ---------- Building blocks --------------------------------------------------

/** ADSR envelope on a GainNode — peak gain at `peak`, returns to zero at `end`. */
function _envelope(gain, t0, attack, peak, decay, sustain, sustainDur, release) {
  gain.gain.cancelScheduledValues(t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  gain.gain.exponentialRampToValueAtTime(Math.max(sustain, 0.0001), t0 + attack + decay);
  gain.gain.setValueAtTime(Math.max(sustain, 0.0001), t0 + attack + decay + sustainDur);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay + sustainDur + release);
}

// ---------- Voices -----------------------------------------------------------

function _voiceTic(t0) {
  // 8 ms square click — very short, very dry. Reads as a haptic-ish click,
  // not a "beep". Two stacked oscillators (square + sine) give it a tiny
  // bit of body without crossing into "tone" territory.
  const ctx = _ctx;
  const g = ctx.createGain();
  const o1 = ctx.createOscillator();
  const o2 = ctx.createOscillator();
  o1.type = "square"; o1.frequency.value = 1800;
  o2.type = "sine";   o2.frequency.value = 3200;
  o1.connect(g); o2.connect(g); g.connect(_master);
  _envelope(g, t0, 0.001, 0.55, 0.012, 0.05, 0.001, 0.020);
  o1.start(t0); o2.start(t0);
  o1.stop(t0 + 0.06); o2.stop(t0 + 0.06);
}

function _voiceWhoosh(t0) {
  // 220 ms downward pitch sweep through filtered noise. Reads as "movement"
  // — pair with the camera fly-to so the audio cues the visual transit.
  const ctx = _ctx;
  const dur = 0.22;
  // White-noise source via buffer.
  const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.85;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  // Bandpass that sweeps down: 1800 Hz → 380 Hz over the clip duration.
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 4.5;
  bp.frequency.setValueAtTime(1800, t0);
  bp.frequency.exponentialRampToValueAtTime(380, t0 + dur);
  const g = ctx.createGain();
  src.connect(bp); bp.connect(g); g.connect(_master);
  _envelope(g, t0, 0.012, 0.55, 0.04, 0.18, 0.10, 0.06);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

function _voicePop(t0) {
  // 90 ms tuned blip — sine osc with a 240 Hz → 880 Hz upward pitch bend.
  // Reads as "selected / picked". Pairs with the asset hotspot burst ring.
  const ctx = _ctx;
  const g = ctx.createGain();
  const o = ctx.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(240, t0);
  o.frequency.exponentialRampToValueAtTime(880, t0 + 0.07);
  // Pinch of harmonic via a triangle one octave up.
  const o2 = ctx.createOscillator();
  o2.type = "triangle";
  o2.frequency.setValueAtTime(480, t0);
  o2.frequency.exponentialRampToValueAtTime(1760, t0 + 0.07);
  const g2 = ctx.createGain();
  g2.gain.value = 0.18;
  o.connect(g); o2.connect(g2); g2.connect(g); g.connect(_master);
  _envelope(g, t0, 0.004, 0.6, 0.02, 0.18, 0.025, 0.04);
  o.start(t0);  o.stop(t0 + 0.12);
  o2.start(t0); o2.stop(t0 + 0.12);
}

function _voiceRise(t0) {
  // 140 ms upward sweep — used when a panel rises from the bottom-bar.
  // Slightly slower and more melodic than a tic so the user reads it as
  // "container opened" rather than "button pressed".
  const ctx = _ctx;
  const g = ctx.createGain();
  const o = ctx.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(440, t0);
  o.frequency.exponentialRampToValueAtTime(1320, t0 + 0.10);
  o.connect(g); g.connect(_master);
  _envelope(g, t0, 0.008, 0.45, 0.04, 0.12, 0.04, 0.05);
  o.start(t0);
  o.stop(t0 + 0.20);
}

// ---------- Public API -------------------------------------------------------

const VOICES = {
  tic:    _voiceTic,
  whoosh: _voiceWhoosh,
  pop:    _voicePop,
  rise:   _voiceRise,
};

/**
 * Play a named UI sound. No-op until the user has first interacted with
 * the page (browsers gate AudioContext on user gesture). Failures are
 * silently swallowed — sounds are micro-feedback, never load-bearing.
 */
export function playSound(name) {
  if (!_enabled) return;
  const ctx = _ensureCtx();
  if (!ctx) return;
  _resume();
  const voice = VOICES[name];
  if (!voice) return;
  try { voice(ctx.currentTime + 0.001); } catch {}
}

/** Globally enable / disable UI sounds (future Settings toggle hook). */
export function setSoundEnabled(on) { _enabled = !!on; }

/**
 * Optional warm-up — call from a documented user gesture (e.g. the
 * loading-splash dismiss) to materialise the AudioContext before any
 * sound is actually requested. Avoids the very first sound being eaten
 * by Safari's "context still suspended" race. Safe to call multiple
 * times; subsequent calls are no-ops.
 */
export function primeSound() {
  const ctx = _ensureCtx();
  if (ctx && ctx.state === "suspended") _resume();
}
