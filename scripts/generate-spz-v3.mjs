// scripts/generate-spz-v3.mjs
// -----------------------------------------------------------------------------
// Generate a SPZ v3 file from the desktop .splat using the SpzWriter exposed
// by @sparkjsdev/spark@0.1.10. Why this exists: PlayCanvas SuperSplat and the
// current Niantic CLI export SPZ v4, which the shipped Spark runtime cannot
// decode (its GunzipReader reads the v3 header layout and chokes on v4's
// different offsets, surfacing as "incorrect header check" in the browser).
//
// Going through Spark's own transcodeSpz guarantees a v3 file because the
// SPZ_VERSION constant in 0.1.10 is hardcoded to 3 (see node_modules/
// @sparkjsdev/spark/dist/types/spz.d.ts:22). When we upgrade Spark to v2.x
// later the constant rolls forward and this script will produce v4 instead,
// matching the runtime automatically.
//
// Usage:
//   node scripts/generate-spz-v3.mjs
//
// Reads:  public/SplatGarden_PC.splat    (the full 3 M splats, ~92 MB)
// Writes: public/SplatGarden_Mobile.spz  (v3, ~30-45 MB after compress)
// -----------------------------------------------------------------------------

import { transcodeSpz } from "@sparkjsdev/spark";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "..");
const SPLAT     = path.join(ROOT, "public", "SplatGarden_PC.splat");
const SPZ_OUT   = path.join(ROOT, "public", "SplatGarden_Mobile.spz");

console.log(`Reading  ${path.relative(ROOT, SPLAT)}`);
const splatBytes = await readFile(SPLAT);
console.log(`  ${(splatBytes.length / 1024 / 1024).toFixed(2)} MB loaded`);

console.log("Transcoding to SPZ v3 (this can take ~30 s for 3 M splats)...");
const t0 = performance.now();
const { fileBytes } = await transcodeSpz({
  inputs: [
    { fileBytes: new Uint8Array(splatBytes), fileType: "splat" },
  ],
});
const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

console.log(`Writing  ${path.relative(ROOT, SPZ_OUT)}`);
await writeFile(SPZ_OUT, fileBytes);

const ratio = (fileBytes.length / splatBytes.length * 100).toFixed(1);
console.log(
  `  ${(fileBytes.length / 1024 / 1024).toFixed(2)} MB ` +
  `(${ratio}% of source, ${elapsed}s)`,
);
console.log("");
console.log("Verify outer wrapper (the SPZ file is gzip-wrapped — NGSP magic");
console.log("and version live INSIDE the compressed payload, not at byte 0):");
const hex = Array.from(fileBytes.slice(0, 4))
  .map(b => b.toString(16).padStart(2, "0")).join(" ");
console.log(`  outer:    ${hex}`);
console.log("  expected: 1f 8b 08 ..  (gzip magic; SPZ wraps the NGSP block in gzip)");
console.log("");
console.log("To inspect the inner header, gunzip the file and look at bytes 0-15.");
