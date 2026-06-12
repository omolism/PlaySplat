// ---------------------------------------------------------------------------
// usd-export — serializes the Voxelizer / Quadizer instance buffers to a
// USDA (text) PointInstancer file, downloaded via a Blob anchor.
//
// LOCAL / PAPER-VALIDATION TOOL — not wired into the visible UI. Invoked
// from the DevTools console via window.__exportUSD (wired in main.js).
//
// Design notes:
//  - USDA is plain text, so no USD runtime is needed in the browser. The
//    binary crate (.usdc) conversion is done offline with the `usdcat`
//    tool that ships with Houdini:
//        usdcat splatgarden-voxel.usda -o splatgarden-voxel.usdc
//    (lossless, and 4-5x smaller thanks to binary arrays + LZ4).
//  - Size optimisations baked into the schema mapping:
//      * orientations[] omitted — voxels are axis-aligned (identity), and
//        billboards are camera-facing at RENDER time, which is a viewer
//        behaviour, not an authored orientation. Omitting the optional
//        attr is spec-legal and saves ~30% of the text.
//      * scales[] omitted — every instance shares one size, so the size
//        is baked into the prototype prim (Cube.size / Plane.width)
//        instead of 1.75M identical scale triplets.
//      * positions to 5 decimals, colors to 4 — sub-voxel precision is
//        noise; trimming digits cuts the USDA roughly in half.
//  - The splat mesh's world transform (the Postshot 180-degree X flip)
//    is written as an xformOp on the PointInstancer so DCCs see the
//    scene in the same orientation as the viewer.
//  - `stride` exports every Nth instance — full 1.75M-cell exports are
//    ~10^2 MB as text; a stride of 4-10 is plenty for interchange
//    validation figures.
// ---------------------------------------------------------------------------

const F5 = (v) => {
  // toFixed(5) but strips trailing zeros so "0.10000" → "0.1". Saves
  // ~20% of file size on grid-aligned voxel coordinates.
  return Number(v.toFixed(5)).toString();
};
const F4 = (v) => Number(v.toFixed(4)).toString();

/**
 * Serialize one PointInstancer layer to a USDA string.
 *
 * @param {object} opts
 * @param {string}        opts.primName   — root prim name ("VoxelLayer")
 * @param {Float32Array}  opts.positions  — xyz triplets, local space
 * @param {Float32Array}  opts.colors     — rgb triplets, linear 0-1
 * @param {number}        opts.count      — instance count
 * @param {"cube"|"sphere"|"plane"} opts.protoShape
 * @param {number}        opts.protoSize  — cube edge / sphere diameter / plane edge
 * @param {number}        [opts.stride=1] — export every Nth instance
 * @param {{rx:number,ry:number,rz:number}} [opts.rotate] — xformOp:rotateXYZ degrees
 * @returns {{ usda: string, exported: number }}
 */
export function serializePointInstancerUSDA({
  primName, positions, colors, count,
  protoShape, protoSize, stride = 1, rotate = null,
}) {
  // ceil, not floor — the position/color loops run `for (i=0; i<count;
  // i+=stride)` which yields ceil(count/stride) entries. Using floor here
  // produced a protoIndices array one element SHORT of positions
  // (caught in usdview's property panel: float3[436335] vs int[436334]).
  // Per the PointInstancer schema all per-instance arrays must agree.
  const exported = Math.ceil(count / stride);

  // ---- prototype prim -----------------------------------------------------
  // USD has true Cube / Sphere / Plane prims — no mesh tessellation needed.
  let protoDef, protoName;
  if (protoShape === "sphere") {
    protoName = "Sphere";
    protoDef  = `        def Sphere "Sphere"\n        {\n            double radius = ${F5(protoSize / 2)}\n        }`;
  } else if (protoShape === "plane") {
    protoName = "Plane";
    protoDef  = `        def Plane "Plane"\n        {\n            double width = ${F5(protoSize)}\n            double length = ${F5(protoSize)}\n            uniform token axis = "Z"\n        }`;
  } else {
    protoName = "Cube";
    protoDef  = `        def Cube "Cube"\n        {\n            double size = ${F5(protoSize)}\n        }`;
  }

  // ---- per-instance arrays ------------------------------------------------
  // Chunked string building: pushing ~10k-instance chunks into an array
  // and joining once avoids the O(n^2) cost of repeated concatenation on
  // multi-million-instance exports.
  const CHUNK = 10_000;
  const posChunks = [];
  const colChunks = [];
  let buf = [];
  for (let i = 0; i < count; i += stride) {
    const k = i * 3;
    buf.push(`(${F5(positions[k])}, ${F5(positions[k + 1])}, ${F5(positions[k + 2])})`);
    if (buf.length >= CHUNK) { posChunks.push(buf.join(", ")); buf = []; }
  }
  if (buf.length) posChunks.push(buf.join(", "));
  buf = [];
  for (let i = 0; i < count; i += stride) {
    const k = i * 3;
    buf.push(`(${F4(colors[k])}, ${F4(colors[k + 1])}, ${F4(colors[k + 2])})`);
    if (buf.length >= CHUNK) { colChunks.push(buf.join(", ")); buf = []; }
  }
  if (buf.length) colChunks.push(buf.join(", "));

  // protoIndices — all zeros (single prototype). USDA has no run-length
  // form, so this is genuinely N comma-separated zeros; usdc's integer
  // compression collapses it to almost nothing after usdcat conversion.
  const zeroChunks = [];
  {
    const zeros = new Array(Math.min(CHUNK, exported)).fill("0").join(", ");
    const full  = Math.floor(exported / CHUNK);
    for (let i = 0; i < full; i++) zeroChunks.push(zeros);
    const rem = exported % CHUNK;
    if (rem) zeroChunks.push(new Array(rem).fill("0").join(", "));
  }

  const xformBlock = rotate
    ? `    float3 xformOp:rotateXYZ = (${rotate.rx}, ${rotate.ry}, ${rotate.rz})\n    uniform token[] xformOpOrder = ["xformOp:rotateXYZ"]\n`
    : "";

  const usda = `#usda 1.0
(
    defaultPrim = "${primName}"
    metersPerUnit = 1
    upAxis = "Y"
    doc = "Exported from a 3DGS web viewer - PointInstancer layer (${protoShape} prototype, ${exported} instances, stride ${stride})"
)

def PointInstancer "${primName}" (
    kind = "component"
)
{
${xformBlock}    point3f[] positions = [${posChunks.join(", ")}]
    int[] protoIndices = [${zeroChunks.join(", ")}]
    color3f[] primvars:displayColor = [${colChunks.join(", ")}] (
        interpolation = "vertex"
    )
    rel prototypes = </${primName}/Prototypes/${protoName}>

    def Scope "Prototypes"
    {
${protoDef}
    }
}
`;
  return { usda, exported };
}

/** Trigger a browser download of a string as a file. */
function downloadText(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Export a built Voxelizer or Quadizer layer. Wired to window.__exportUSD
 * in main.js. Usage from the DevTools console:
 *
 *   __exportUSD("voxel")                 // full voxel layer
 *   __exportUSD("voxel",     { stride: 4 })
 *   __exportUSD("billboard", { stride: 10 })
 */
export function exportLayerUSDA(layer, { voxelizer, quadizer, stride = 1 } = {}) {
  let result;
  if (layer === "billboard" || layer === "quad") {
    // Build on demand — rebuild() is a synchronous CPU pass, so the export
    // is self-sufficient even if the layer was never toggled visible.
    if (!quadizer?.mesh) quadizer?.rebuild?.();
    const mesh = quadizer?.mesh;
    if (!mesh) { console.warn("[usd-export] Quadizer not built — enable the Billboard layer first."); return; }
    const g = mesh.geometry;
    result = serializePointInstancerUSDA({
      primName:   "BillboardLayer",
      positions:  g.attributes.aInstanceCenter.array,
      colors:     g.attributes.aInstanceColor.array,
      count:      g.instanceCount,
      protoShape: "plane",
      protoSize:  quadizer.quadSize,
      stride,
      rotate:     { rx: 180, ry: 0, rz: 0 },   // Postshot Y-up flip
    });
    downloadText(result.usda, "splatgarden-billboard.usda");
  } else {
    if (!voxelizer?.mesh) voxelizer?.rebuild?.();
    const mesh = voxelizer?.mesh;
    if (!mesh) { console.warn("[usd-export] Voxelizer not built — enable the Voxel layer first."); return; }
    const g = mesh.geometry;
    result = serializePointInstancerUSDA({
      primName:   "VoxelLayer",
      positions:  g.attributes.aInstanceCenter.array,
      colors:     g.attributes.aInstanceColor.array,
      count:      g.instanceCount,
      protoShape: voxelizer.shape === "sphere" ? "sphere" : "cube",
      protoSize:  voxelizer.voxelSize,
      stride,
      rotate:     { rx: 180, ry: 0, rz: 0 },
    });
    downloadText(result.usda, "splatgarden-voxel.usda");
  }
  console.info(`[usd-export] wrote ${result.exported} instances (stride ${stride}), ${(result.usda.length / 1e6).toFixed(1)} MB of USDA`);
  console.info(`[usd-export] convert to binary crate with Houdini's usdcat:`);
  console.info(`             usdcat splatgarden-voxel.usda -o splatgarden-voxel.usdc`);
}
