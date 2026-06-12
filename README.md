# PlaySplat

A browser-based multi-representation viewer for 3D Gaussian Splatting scenes,
built on Three.js and [@sparkjsdev/spark](https://github.com/sparkjsdev/spark).

A single 3DGS asset is maintained as three co-registered representations that
cross-fade freely in one WebGL 2 context:

- **Splat** — anisotropic Gaussians (source of truth), with a Gaussian/Point
  sub-form morph
- **Billboard** — camera-facing planes mirroring the OpenUSD
  `UsdGeomPointInstancer` data model (quad / antialiased disc prototypes)
- **Voxel** — uniform-grid clustering over cube / sphere prototypes

## Features

- **OpenUSD interchange** — billboard and voxel layers serialize to `.usda`
  directly in the browser (no USD runtime needed); output passes `usdchecker`
  and converts losslessly to `.usdc` with `usdcat`
- **Format-adaptive delivery** — phones are probed via HTTP HEAD and served an
  SPZ-compressed variant at roughly half the desktop payload
- **Hand interaction** — in-browser MediaPipe hand tracking (One-Euro filtered
  pinch with hysteresis) and mouse raycasts normalized into one spatial
  interface driving eight per-splat shader effects
- **Drag-and-drop** — load your own `.splat` / `.ply` / `.spz` / `.ksplat`
  scenes and read them through the same three representations
- **Post-FX chain** — bloom, kaleidoscope, lens warp, underwater, painterly
  modes, plus a GPGPU particle pass advected by a ping-pong velocity field

## Quick start

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Console helpers for research use:

```js
__exportUSD("voxel", { stride: 4 })       // download the voxel layer as USDA
__exportUSD("billboard", { stride: 10 })  // download the billboard layer
```

Convert and validate with OpenUSD tooling:

```bash
usdcat layer.usda -o layer.usdc
usdchecker layer.usdc
```

## License

See individual dependency licenses. Scene assets are provided for
demonstration purposes.
