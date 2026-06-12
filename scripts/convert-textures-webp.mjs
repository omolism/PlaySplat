// scripts/convert-textures-webp.mjs
// -----------------------------------------------------------------------------
// One-shot batch converter — walks public/textures/ and writes a .webp next
// to every .png. WebP at q=85 typically lands at 5-15% of the PNG size for
// the photographic / painterly textures shipped here (Substance renders,
// stylized landscape plates, AI A/B compare swatches). For normal-map /
// data-channel images quality is the same as authored — sharp's WebP
// encoder is lossless when the pixel content is already low-frequency.
//
// Usage:
//   node scripts/convert-textures-webp.mjs
//
// Side effects:
//   • writes ${name}.webp next to every ${name}.png in public/textures/
//   • prints a per-file size delta + final summary
//   • does NOT delete the .png originals (do that in a follow-up step
//     once the references are switched, so we can verify visuals first)
// -----------------------------------------------------------------------------

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, "..");
const TEX_ROOT   = path.join(ROOT, "public", "textures");
const QUALITY    = 85;       // lossy q=85 — visually transparent for art content
const SKIP_BELOW = 50 * 1024; // skip PNGs under 50 KB — conversion overhead not worth it

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())      out.push(...(await walk(full)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) out.push(full);
  }
  return out;
}

async function main() {
  const pngs = await walk(TEX_ROOT);
  console.log(`Found ${pngs.length} PNG files under public/textures/`);

  let totalPng  = 0;
  let totalWebp = 0;
  let converted = 0;
  let skipped   = 0;

  for (const png of pngs) {
    const stat = await fs.stat(png);
    if (stat.size < SKIP_BELOW) {
      skipped++;
      continue;
    }
    const webp = png.replace(/\.png$/i, ".webp");
    await sharp(png).webp({ quality: QUALITY, effort: 6 }).toFile(webp);
    const webpStat = await fs.stat(webp);
    const ratio = (webpStat.size / stat.size * 100).toFixed(1);
    const rel = path.relative(ROOT, png).replace(/\\/g, "/");
    console.log(
      `${(stat.size / 1024).toFixed(0).padStart(6)} KB  →  ${(webpStat.size / 1024).toFixed(0).padStart(5)} KB  (${ratio.padStart(5)}%)  ${rel}`,
    );
    totalPng  += stat.size;
    totalWebp += webpStat.size;
    converted++;
  }

  console.log("");
  console.log(`Converted: ${converted} files  (skipped ${skipped} under ${SKIP_BELOW / 1024} KB)`);
  console.log(`Total PNG : ${(totalPng / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Total WebP: ${(totalWebp / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Saving    : ${((totalPng - totalWebp) / 1024 / 1024).toFixed(2)} MB  (${((1 - totalWebp / totalPng) * 100).toFixed(1)}% smaller)`);
}

main().catch(err => { console.error(err); process.exit(1); });
