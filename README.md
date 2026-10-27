# Ink Ribbon

A 3D wireframe map of the Raccoon Police Department, floors 1–3, extracted from
*Resident Evil 2* (RT build) and rendered in the browser with sokol compiled to
WebAssembly. Orbit the model, pan it, or hold right-click and fly through it.

![RPD floors 1–3](docs/preview.jpg)

## What is in here

- **Level data** — all 49 RPD terrain meshes for 1F, 2F and 3F, read directly
  from the game's PAK archives and reduced to a stylized architectural plan:
  three floor plates on a 3 m grid, skeletonized room/corridor walls, and simple
  stair runs. Props, mouldings, railings and high-frequency detail are dropped;
  the room layout and scale are preserved.
- **Renderer** — a C application using the latest [sokol](https://github.com/floooh/sokol)
  (`sokol_app` + `sokol_gfx`), compiled to WebAssembly with Emscripten. It draws
  black-filled plates with depth-faded white edges, separates the three floors
  vertically, and adds a small bloom pass.
- **Web app** — React 19 + TypeScript on [Void](https://github.com/voidzero-dev/void)
  1.3.0 (Vite 8) targeting Cloudflare Workers. Once the scene is loaded the
  page is only the canvas; no labels or UI sit on top of it.

## Stack

| Part | Version |
|---|---|
| TypeScript | 7.0.2 |
| Vite | 8.3.5 |
| React / React DOM | 19.3.1 |
| Void SDK / CLI | 1.3.0 |
| sokol | `fe6e78dee2377e84bc6ade95f0dcd82b4fcd86e9` (2026-10-26) |
| Emscripten | 6.0.13 |
| Plan builder | numpy, Pillow, scikit-image |

## Run it

```bash
# Node 24.21+ is required by Void. If npm is configured with omit=dev,
# install the build tooling explicitly:
npm install --include=dev

npm run dev
```

Production build and local Worker preview:

```bash
npm run build
npm run preview
```

Rebuild the scene data from the installed game:

```bash
# 1. read the 49 terrain meshes from the RE2 RT PAK (68.5 MB, not committed)
uv run --with zstandard python tools/extract_rpd.py

# 2. build public/rpd/rpd.bin from data/raw/rpd
uv run --with numpy --with pillow --with scikit-image python tools/build_plan.py
npm run wasm   # only needed after changing native/main.c
```

`RE2_GAME_DIR` overrides the Steam install path. The extraction tooling is
derived from `~/repos/reze`; see [docs/extraction.md](docs/extraction.md).

## Controls

| Input | Action |
|---|---|
| Left drag | Orbit |
| Middle drag | Pan |
| Wheel / pinch | Zoom |
| Hold right click + mouse | Free-look |
| `W` / `S` (while flying) | Forward / back along the view |
| `A` / `D` (while flying) | Strafe left / right |
| `Q` / `E` (while flying) | Fly up / down |
| `Shift` (while flying) | 3× fly speed |
| `R` | Reset camera |
| One-finger drag | Orbit |
| Two-finger drag | Pan and pinch-zoom |

Right click seeds the fly camera from the current orbit view. Releasing the
button returns to orbit mode around a point ahead, so the transition is seamless.

## Deploy to Cloudflare

Void builds and deploys the app as a Cloudflare Worker:

```bash
npx void connect --platform cloudflare   # once, links the account
npm run deploy
```

`void.config.ts` pins the Worker compatibility date. The connected account is
written to `.void/` and `void.lock.json`; both are intentionally gitignored so
the repository does not contain an account ID. A fresh clone only needs
`void connect`.

## Layout

```
tools/extract_rpd.py       PAK lookup + extraction of the 49 RPD meshes
tools/re_pak.py            minimal KPKA v4 reader (Murmur3 path hashes)
tools/remesh.py            RE2 RT .mesh parser (LODs, groups, submeshes, buffers)
tools/build_plan.py        floor plates, skeletonized walls, stairs, RPDW writer
tools/rpd_floor_meshes.txt exact PAK paths for floors 1-3
native/main.c              sokol app: camera, input, wireframe + bloom passes
native/third_party/sokol   vendored sokol headers (pinned commit)
native/build.sh            Emscripten build
src/RpdScene.tsx           React canvas + WASM loader with progress
src/wasm/rpd.js            generated Emscripten ES module (committed for deploy)
pages/index.tsx            Void page
public/rpd/rpd.bin         derived floor-plan scene (66 KB)
public/rpd/rpd.wasm        compiled sokol renderer
```

## Scene notes

The source meshes are in world space. Each room is a set of mesh groups; face
indices are relative to each material subdivision's vertex slice. The plan pass
keeps LOD 0 and turns the geometry into three plates:

1. **Floor plates** — upward horizontal surfaces within 1.5 m of 0 / 5 / 10.25 m,
   with giant backdrop triangles (>50 m²) removed. Room masks are filled, the 1F
   mask is clipped to the upper-floor footprint plus the main hall, and the
   plates are emitted as 3 m fill tiles; the visible 3 m grid is drawn
   procedurally in the fragment shader.
2. **Walls** — vertical surfaces at each level projected into a 2D wall mask,
   skeletonized, then emitted as 4 m-tall wall runs. Openings and doors survive
   as gaps in the skeleton.
3. **Stairs** — source-detected flights plus the main-hall and west upper
   flights shown by the interactive RPD map. Every flight now reaches the next
   plate through a slot cut in that plate, with a landing at each end.

The result is 2,016 triangles and 1,861 lines from 1,790,053 source triangles.
A 2× vertical scale puts the plates at 0 / 10 / 20.5 m, so the levels stay
readable while the stairs keep their real rise. The 3F clock-tower exterior sits
above the third plate and is omitted.

## Assets and licensing

The project code is MIT. The retail game assets remain the property of Capcom.
`data/raw/` is gitignored; the derived `public/rpd/rpd.bin` is included so the
demo runs without an installation. No original PAK files are redistributed.

Third-party: sokol (zlib/libpng), Emscripten (MIT/NCSA), React (MIT), Void
(MIT), scikit-image (BSD-3-Clause). The RE mesh layout was checked against
[NSACloud's RE Mesh Editor](https://github.com/NSACloud/RE-Mesh-Editor); no addon
code is vendored or called at runtime.
