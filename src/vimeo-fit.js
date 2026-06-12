// ---------------------------------------------------------------------------
// vimeo-fit.js — eliminate Vimeo's internal letterbox bars by reading each
// embedded clip's actual width × height via the Vimeo Player API and setting
// the iframe container's `aspect-ratio` to match. With this in place, every
// `.ah-embed-frame` resizes itself to fit its specific clip — 16:9, 21:9,
// 9:16, 4:3, anything — and the black bars Vimeo paints inside the iframe
// disappear because the iframe IS the video's natural aspect.
//
// Usage:
//   import { fitVimeoFrames } from "./vimeo-fit.js";
//   fitVimeoFrames(rootEl);            // run after innerHTML is set
//
// Idempotent — each iframe is tagged so subsequent calls skip already-fitted
// frames. Safe to call after every card / drawer render.
//
// Requires `window.Vimeo.Player` (loaded via the `<script>` tag in
// index.html). If the API isn't ready yet, we poll briefly and retry —
// the script is `async` so on a cold page load it may land after the
// first card opens.
// ---------------------------------------------------------------------------

const READY_POLL_MS  = 80;
const READY_TIMEOUT  = 8000;   // give up after 8 s if the API never loads

/**
 * Wait until window.Vimeo.Player exists (the async player.js script has
 * finished loading), then resolve. Rejects after READY_TIMEOUT.
 */
function _whenVimeoReady() {
  return new Promise((resolve, reject) => {
    if (window.Vimeo?.Player) return resolve(window.Vimeo);
    const t0 = performance.now();
    const tick = () => {
      if (window.Vimeo?.Player) return resolve(window.Vimeo);
      if (performance.now() - t0 > READY_TIMEOUT) return reject(new Error("Vimeo Player API failed to load"));
      setTimeout(tick, READY_POLL_MS);
    };
    tick();
  });
}

/**
 * Fit a single Vimeo iframe's container to the clip's natural aspect.
 * Idempotent — guarded via `data-vimeoFit` so re-runs skip done frames.
 */
async function _fitOne(iframe) {
  if (!iframe || iframe.dataset.vimeoFit === "1") return;
  iframe.dataset.vimeoFit = "pending";
  let Vimeo;
  try { Vimeo = await _whenVimeoReady(); }
  catch { iframe.dataset.vimeoFit = "no-api"; return; }
  try {
    const p = new Vimeo.Player(iframe);
    const [w, h] = await Promise.all([p.getVideoWidth(), p.getVideoHeight()]);
    if (!w || !h) { iframe.dataset.vimeoFit = "no-dims"; return; }
    const parent = iframe.parentElement;
    if (parent) {
      // Set the container's aspect-ratio inline so it wins against the
      // 16:9 default in .ah-embed-frame's stylesheet rule. The iframe
      // continues to fill 100% × 100% of the container, but the
      // container is now sized to the clip's actual ratio — no
      // Vimeo-painted bars anywhere.
      parent.style.aspectRatio = `${w} / ${h}`;
      // Drop the solid black background that used to hide letterbox
      // bars: with the container at the correct ratio, any sub-pixel
      // rounding looks better against transparent than against #000.
      parent.style.background = "transparent";
    }
    iframe.dataset.vimeoFit = "1";
  } catch (err) {
    iframe.dataset.vimeoFit = "error";
    // Swallow — bar-removal is a polish layer, not load-bearing.
    // console.debug("[vimeo-fit] couldn't measure iframe:", err);
  }
}

/**
 * Scan `root` for Vimeo iframes (`<iframe src*="player.vimeo.com">`)
 * and fit each one. Called by asset-hover.js _show() after renderCard()
 * injects the card content into the DOM, and by tech-spec.js openOverlay()
 * for the Pipeline drawer which also embeds clips per-asset.
 *
 * Async dispatch — each iframe is fitted in parallel; we don't await
 * the batch because the visual fix is best-effort and shouldn't block
 * the caller's UI thread.
 */
export function fitVimeoFrames(root = document) {
  const iframes = root.querySelectorAll('iframe[src*="player.vimeo.com"]');
  iframes.forEach(_fitOne);
}
