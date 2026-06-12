// SplatGarden service worker — runtime-caching PWA.
//
// Strategy is "stale-while-revalidate for heavy assets, network-first for
// HTML". The splat / SPZ / textures / HDR sky / JS chunks make up the
// vast majority of the page weight (the SPZ alone is ~44 MB on mobile,
// the splat ~88 MB on desktop), so caching them after first visit makes
// the second visit feel instant. HTML is deliberately network-first so
// a deploy doesn't trap users on a stale UI.
//
// Cache versioning: the CACHE_VERSION at the top is the cache namespace.
// Bump it on schema-breaking changes to force a clean rebuild. The
// activate event cleans up older versions so the storage footprint
// doesn't grow forever across deploys.
//
// IMPORTANT: this file is served from `/public/sw.js` (Vite copies it
// verbatim to the build root). The scope is the deploy root
// (`/SplatGarden/` on Pages, `/` in dev), so we register it from
// main.js with that base path.

const CACHE_VERSION = "splatgarden-v1";
const HTML_TIMEOUT_MS = 3000;

// File patterns that are safe to cache long-term. Vite hashes every
// generated JS / CSS chunk filename, so a deploy that ships new chunks
// can't be served stale (the URL changes). Splat / texture / HDR / SPZ
// files are versioned by their filename — bump the filename to bust the
// cache. Anything not matching falls through to network-first.
const CACHE_PATTERNS = [
  /\.(?:splat|spz|ply|ksplat)(?:\?|$)/i,
  /\.(?:webp|png|jpg|jpeg|hdr|exr|ktx2)(?:\?|$)/i,
  /\/assets\/.+\.(?:js|css)(?:\?|$)/i,
  /\.(?:woff2?|ttf|otf)(?:\?|$)/i,
];

function shouldCache(url) {
  try {
    const u = new URL(url);
    // Only cache same-origin assets. Cross-origin (Vimeo iframes,
    // MediaPipe CDN models) handle their own caching.
    if (u.origin !== self.location.origin) return false;
    return CACHE_PATTERNS.some((re) => re.test(u.pathname));
  } catch {
    return false;
  }
}

self.addEventListener("install", (event) => {
  // Skip waiting so a new SW version takes over the page on next reload
  // without requiring a tab close + reopen.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== CACHE_VERSION && k.startsWith("splatgarden-"))
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = req.url;

  // Heavy assets — stale-while-revalidate. Return cached copy if any,
  // and fetch a fresh one in the background so the next visit gets
  // the newest version. Network failure on revalidate is silent: the
  // cached copy is still served, so an offline second visit still
  // boots a working scene.
  if (shouldCache(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(req);
      const networkFetch = fetch(req).then((res) => {
        if (res && res.ok && res.type === "basic") {
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      }).catch(() => null);
      return cached || (await networkFetch) || new Response("Offline", { status: 503 });
    })());
    return;
  }

  // HTML / navigations — network-first with a short timeout so an
  // unreachable network falls back to the cached shell. Without this
  // path, a flaky connection would hang on the index.html request
  // forever instead of degrading to the last-known-good build.
  if (req.mode === "navigate" || (req.destination === "document")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      try {
        const network = await Promise.race([
          fetch(req),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), HTML_TIMEOUT_MS)),
        ]);
        if (network && network.ok) {
          cache.put(req, network.clone()).catch(() => {});
          return network;
        }
        const cached = await cache.match(req);
        return cached || network;
      } catch {
        const cached = await cache.match(req);
        return cached || fetch(req);
      }
    })());
    return;
  }
  // Anything else (Vimeo, MediaPipe CDN, etc.) — default browser handling.
});
