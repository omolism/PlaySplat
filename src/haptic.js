// ---------------------------------------------------------------------------
// haptic.js — tiny wrapper around the Web Vibration API.
//
// Native iOS Safari doesn't expose vibrate() (Apple's policy); Android Chrome,
// many touch laptops, and some Windows hybrids do. We wrap the no-op-on-iOS
// case so callsites can fire freely without feature-detection boilerplate.
// Failures are silently swallowed — haptics are micro-feedback, never
// load-bearing UX.
//
// Pick the right duration for the action:
//   • 6–10 ms  → tic (toggle flip, pill click, viewpoint snap, scrub release)
//   • 12–18 ms → confirm (asset selected, drop-zone accept)
//   • 30 ms    → warning (rare — error, blocked action)
//
// Anything longer reads as buzzing rather than a tactile pulse; avoid.
// ---------------------------------------------------------------------------

let _enabled = true;

/**
 * Fire a haptic pulse for the given duration in ms.
 * No-op on platforms without Vibration API (notably iOS Safari) or when
 * disabled via setHapticEnabled(false).
 */
export function haptic(ms = 10) {
  if (!_enabled) return;
  if (typeof navigator === "undefined") return;
  if (typeof navigator.vibrate !== "function") return;
  try { navigator.vibrate(ms); } catch { /* spec-compliant browsers don't throw, but be safe */ }
}

/** Globally enable / disable haptic feedback (e.g. for a future Settings toggle). */
export function setHapticEnabled(on) { _enabled = !!on; }
