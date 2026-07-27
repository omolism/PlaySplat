# PlaySplat

A browser-based multi-representation viewer for 3D Gaussian Splatting scenes,
built on Three.js and [@sparkjsdev/spark](https://github.com/sparkjsdev/spark).

Live at **[playsplats.com](https://playsplats.com)**.

PlaySplat is a spin-off of [SplatGarden](https://splatgarden.com). Where
SplatGarden presents the finished artwork, PlaySplat focuses on interaction
and customization: every parameter exposed, drag-and-drop scene loading,
and OpenUSD export for research and tinkering.

## Paper

The system is described in a peer-reviewed short paper at **Web3D 2026**, the
31st International Conference on 3D Web Technology (Doha, October 2026),
published open access under CC-BY.

> Danci Shen and Itim Kongsakulvatanasook. 2026. From Viewing to Playing:
> Bring-Your-Own-Scene Interaction for 3D Gaussian Splatting on the Web. In
> *The 31th International Conference on 3D Web Technology (Web3D '26)*. ACM.
> https://doi.org/10.1145/3822516.3834873

<details>
<summary>BibTeX</summary>

```bibtex
@inproceedings{shen2026playsplat,
  author    = {Shen, Danci and Kongsakulvatanasook, Itim},
  title     = {From Viewing to Playing: Bring-Your-Own-Scene Interaction for
               3D Gaussian Splatting on the Web},
  booktitle = {The 31th International Conference on 3D Web Technology (Web3D '26)},
  year      = {2026},
  publisher = {Association for Computing Machinery},
  doi       = {10.1145/3822516.3834873}
}
```
</details>

The DOI resolves once the proceedings are published. GitHub also reads
`CITATION.cff`, so the *Cite this repository* button on the sidebar produces the
same reference in APA or BibTeX.

Figures and measurements in the paper use the public
[antimatter15 train capture](https://github.com/antimatter15/splat), so the
results read against a neutral, widely used benchmark.

A single 3DGS asset is maintained as three co-registered representations that
cross-fade freely in one WebGL 2 context:

- **Splat**: anisotropic Gaussians (source of truth), with a Gaussian/Point
  sub-form morph
- **Billboard**: camera-facing planes mirroring the OpenUSD
  `UsdGeomPointInstancer` data model (quad / antialiased circle prototypes)
- **Voxel**: uniform-grid clustering over cube / sphere prototypes

## Features

- **OpenUSD interchange**: billboard and voxel layers serialize to `.usda`
  directly in the browser (no USD runtime needed); output passes `usdchecker`
  and converts losslessly to `.usdc` with `usdcat`
- **Format-adaptive delivery**: phones are probed via HTTP HEAD and served an
  SPZ-compressed variant at roughly half the desktop payload
- **Hand interaction**: in-browser MediaPipe hand tracking (One-Euro filtered
  pinch with hysteresis) and mouse raycasts normalized into one spatial
  interface driving seven per-splat shader effects
- **Drag-and-drop**: load your own `.splat` / `.ply` / `.spz` / `.ksplat`
  scenes and read them through the same three representations
- **Post-FX chain**: bloom, kaleidoscope, lens warp, underwater, painterly
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

The source code is released under the [MIT License](LICENSE).

This does not extend to the scene assets in `public/`, which are artwork rather
than code. They ship with the repository so the viewer runs out of the box and
are provided for demonstration only; all rights to them are reserved. Any
capture you load yourself remains entirely yours, and nothing you drop into the
page leaves your browser.
