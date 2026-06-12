// ---------------------------------------------------------------------------
// ticker.js — animated number counters with cubic ease-out + compact /
// comma formatting. Used by Tech Breakdown (footer counts, Overview hero
// stats) to roll values from 0 up to their target when the panel is
// revealed. Cheap to fire (single rAF per ticker; ≤ 60 frames over 1.4 s
// = ≈ 84 textContent writes per number, no layout shift because the
// span's max width is reserved before the animation starts).
//
// Markup pattern:
//   <span class="ticker"
//         data-target="3000000"
//         data-format="compact">0</span>
//
//   data-target  — integer to roll TO
//   data-format  — "plain" (1234) | "comma" (1,234) | "compact" (1.23K / 1.23M)
//   data-suffix  — optional text appended after the value (e.g. " splats")
//   data-decimals — for compact mode, decimal places (default 2)
//   data-duration — ms (default 1400)
//
// initTickers(root, { immediate }) finds every `.ticker[data-target]`
// descendant of `root` and starts the animation. With { immediate: false }
// (the default), each ticker auto-starts when it first scrolls into the
// viewport via IntersectionObserver — so off-screen drawers don't burn
// rAF cycles before the user actually sees them.
// ---------------------------------------------------------------------------

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

function _format(value, fmt, decimals) {
  if (fmt === "compact") {
    const abs = Math.abs(value);
    if (abs >= 1e9) return `${(value / 1e9).toFixed(decimals)}B`;
    if (abs >= 1e6) return `${(value / 1e6).toFixed(decimals)}M`;
    if (abs >= 1e3) return `${(value / 1e3).toFixed(decimals)}K`;
    return decimals > 0 ? value.toFixed(decimals) : Math.round(value).toString();
  }
  if (fmt === "comma") {
    return Math.round(value).toLocaleString("en-US");
  }
  // "plain" — honour decimals when set (e.g. "16.67 s" needs decimals=2);
  // default of 0 still produces clean integers for the common case.
  return decimals > 0 ? value.toFixed(decimals) : Math.round(value).toString();
}

/**
 * Animate a single ticker span from 0 (or `from`) up to `target` over
 * `duration` ms. Uses cubic ease-out so the number sprints at first
 * and settles into the final value — feels like a slot machine
 * landing, not a linear count.
 */
export function rollTicker(el, opts = {}) {
  if (!el || el.dataset.tickerActive === "1") return;
  el.dataset.tickerActive = "1";

  const target   = Number(opts.target   ?? el.dataset.target ?? 0);
  const from     = Number(opts.from     ?? 0);
  const format   = String(opts.format   ?? el.dataset.format   ?? "plain");
  const suffix   = String(opts.suffix   ?? el.dataset.suffix   ?? "");
  // Default 0 so integer targets render cleanly ("990", not "990.00").
  // Callers that want fractional output (e.g. "16.67 s") opt in via
  // data-decimals="2".
  const decimals = Number(opts.decimals ?? el.dataset.decimals ?? 0);
  const duration = Number(opts.duration ?? el.dataset.duration ?? 1400);

  // Reserve final width so the digits don't push siblings around as the
  // counter grows. Render the final value invisibly, measure, then set
  // a min-width and start from 0.
  const finalText = _format(target, format, decimals) + suffix;
  const probe = document.createElement("span");
  probe.style.cssText = "visibility:hidden;position:absolute;white-space:nowrap;";
  probe.textContent = finalText;
  el.appendChild(probe);
  const minWidth = probe.offsetWidth;
  el.removeChild(probe);
  el.style.display    = "inline-block";
  el.style.minWidth   = minWidth + "px";
  el.style.textAlign  = el.style.textAlign || "right";

  const t0 = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - t0) / duration);
    const eased = easeOutCubic(t);
    const v = from + (target - from) * eased;
    el.textContent = _format(v, format, decimals) + suffix;
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * Scan `root` for ticker spans and fire each one. With observe = true
 * (default), uses IntersectionObserver so each span only starts when
 * it first becomes visible — perfect for collapsed drawers / off-screen
 * sections that may never be seen at all.
 */
export function initTickers(root = document, { observe = true } = {}) {
  const tickers = root.querySelectorAll(".ticker[data-target]");
  if (!tickers.length) return;

  if (!observe || typeof IntersectionObserver === "undefined") {
    tickers.forEach(t => rollTicker(t));
    return;
  }

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        rollTicker(entry.target);
        io.unobserve(entry.target);
      }
    }
  }, { threshold: 0.4 });

  tickers.forEach(t => io.observe(t));
}
