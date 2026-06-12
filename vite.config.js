import { defineConfig } from "vite";

// Cloudflare Pages builds are explicitly disabled — the splat asset
// exceeds CF's 25 MB per-file ceiling, and the project is deployed via
// GitHub Pages. CF Pages sets CF_PAGES=1 during its build environment;
// if we see that, fail immediately with a clear message so it doesn't
// silently waste build minutes.
if (process.env.CF_PAGES) {
  throw new Error(
    "Cloudflare Pages builds are disabled for this project. " +
    "Deploy via GitHub Pages instead — see .github/workflows/deploy-pages.yml. " +
    "Disconnect the repo in the Cloudflare dashboard to stop these builds."
  );
}

// VITE_BASE — sub-path under which the app is served, e.g.
// "/SplatGarden/" for GitHub Pages on a project page, or "/"
// for `npm run dev`. Default is "/" so local dev works without env
// config. The GitHub Actions workflow sets VITE_BASE to the repo slug
// before running `npm run build`.
export default defineConfig({
  base: process.env.VITE_BASE || "/",
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  // Don't bundle the giant splat file
  assetsInclude: ["**/*.splat", "**/*.ply", "**/*.spz", "**/*.ksplat"],
  build: {
    rollupOptions: {
      output: {
        // Vendor splitting — break the single 1.6 MB monolith into
        // logically-cacheable chunks so browsers can fetch them in
        // parallel, and a redeploy that touches only our src/ doesn't
        // bust the cache for the much larger three / spark vendor code.
        //
        // MediaPipe is loaded via a dynamic import() inside
        // handtracking.js (_ensureModel), so Rollup automatically
        // emits its chunk separately and the main bundle no longer
        // pays for it on first paint. The IS_PHONE Battery default
        // also leaves hand tracking off out of the gate on mobile,
        // so the MediaPipe chunk is genuinely deferred until the
        // user opts in via the Hand toggle.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@mediapipe"))    return "mediapipe";
          if (id.includes("@sparkjsdev"))   return "spark";
          if (id.includes("/three/"))       return "three";
          if (id.includes("/lil-gui/"))     return "lil-gui";
          return "vendor";
        },
      },
    },
  },
});
