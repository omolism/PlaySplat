# _archive — files held out of the public/ ship folder

Anything in here is intentionally NOT served by Vite at runtime and NOT
copied into `dist/` on build. The folder is a staging area for assets
that exist on disk but should not ship with the site.

## Current contents

### SplatGarden_PC.spz.v4-incompatible-with-spark-0.1.10

A 44 MB SPZ-compressed splat exported by PlayCanvas SuperSplat (or a
recent Niantic CLI) at format **version 4**. The shipped Spark runtime
(`@sparkjsdev/spark@0.1.10`) only supports SPZ **version 3** (see
`node_modules/@sparkjsdev/spark/dist/types/spz.d.ts:22`
`export declare const SPZ_VERSION = 3`).

Loading this file on mobile produced "incorrect header check" when
Spark's `GunzipReader` started parsing the v4 header at v3 offsets, so
it was pulled out of `public/` to restore the page. The
`pickSplatUrl()` HEAD probe in `main.js` now 404s on the SPZ and
gracefully falls back to `SplatGarden_PC.splat`.

To re-enable mobile SPZ routing, do either:

1. **Regenerate as SPZ v3** — easiest path is `node scripts/generate-spz-v3.mjs`,
   which uses the shipped Spark's own `transcodeSpz` so the output
   version necessarily matches the runtime. The script writes
   `public/SplatGarden_Mobile.spz`, which `pickSplatUrl()` then picks
   up via its HEAD probe. (External tools — PlayCanvas SuperSplat
   export, the upstream Niantic CLI — also work as long as you can
   pin them to a version that emits SPZ v3.)

2. **Upgrade Spark to v2.x** — `npm install @sparkjsdev/spark@^2.1.0`.
   v2 supports SPZ v4 natively (and breaks the 0.1.10 API in places;
   audit `main.js` usage of `SparkRenderer` / `SplatMesh` before
   committing the upgrade). After the upgrade, re-running
   `generate-spz-v3.mjs` will automatically emit v4 because Spark's
   `SPZ_VERSION` constant rolls forward in lockstep.
