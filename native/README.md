# Renderer

A single C file (`main.c`) using sokol. It is compiled to WebAssembly and
loaded by `src/RpdScene.tsx`.

## sokol

Vendored headers are pinned at the upstream commit:

```
fe6e78dee2377e84bc6ade95f0dcd82b4fcd86e9   2026-10-26
```

Files: `sokol_app.h`, `sokol_gfx.h`, `sokol_glue.h`, `sokol_log.h`,
`sokol_time.h`, `LICENSE`. `SOKOL_GLES3` selects the GLES3/WebGL2 backend.

## Build

```bash
bash native/build.sh
```

The script sources `$EMSDK/emsdk_env.sh` (default `~/emsdk`, Emscripten 6.0.13)
and runs:

```
emcc native/main.c -o src/wasm/rpd.js
  -I native/third_party/sokol -O3
  -sUSE_WEBGL2=1 -sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createRpdModule
  -sENVIRONMENT=web -sFILESYSTEM=0
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=1073741824
  -sNO_EXIT_RUNTIME=1
  -sEXPORTED_FUNCTIONS=_main,_malloc,_free,_rpd_load_scene
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32
```

`rpd.wasm` is moved to `public/rpd/`, where the generated module locates it
through `locateFile`.

## Frame

1. **Offscreen pass** — one RGBA8 color image and one depth image at canvas
   resolution, sample count 1.
2. **Fill** — the scene's triangles with a very dark, normal-shaded material.
   Up-facing fill pixels get a procedural 3 m world-space grid from the fragment
   shader, so floor grids cost no edge indices. Depth writes are enabled.
3. **Wireframe** — the unique edge list with a small clipped-space depth bias
   (`clip.z -= 0.00012 * clip.w`) so edges survive against their own faces.
   Edges fade toward the background with view distance.
4. **Composite to the swapchain** — a fullscreen triangle samples the offscreen
   color, adds a 9-tap threshold blur (bloom), a radial background gradient,
   vignette and a small grain term. The composite pipeline uses the canvas's
   MSAA sample count.

The scene is split into three draw ranges (1F/2F/3F) from the asset header. The
asset is pre-scaled 2× vertically, putting the plates at 0 / 10 / 20.5 m and
preserving the stair rises. The `y_offset` uniform is therefore zero; it remains
available for a future exploded view.

## Input

`sapp_event` handles mouse orbit/pan/zoom, one- and two-finger touch, and `R` to
reset the camera. Drag scale is derived from the camera distance and the
vertical FOV so a pixel of drag maps to a constant world distance.

Holding the right mouse button enters a free-fly camera seeded from the current
orbit eye and orientation:

- mouse movement looks around;
- `W`/`S` move along the view direction, `A`/`D` strafe horizontally;
- `Q`/`E` move world-up/world-down;
- left `Shift` multiplies speed by 3 (22 m/s base).

Releasing the right button converts the current eye/orientation back into the
orbit camera (target placed one orbit distance ahead), so the view does not
jump. `fly_begin`/`fly_end` live next to `camera_eye` in `main.c`.

## Camera

- Perspective, 0.62 rad vertical FOV.
- Default yaw −0.55 rad, pitch 0.72 rad.
- Distance is 133 units on a 1600 px canvas, scaled up on narrower viewports;
  it is recomputed on resize until the user moves the camera.
- Target is the X/Z centre of the scene bounds with Y at 34% of the scaled
  height range, which frames all three floor plates.

The asset is in metres, Y-up, with the RPD main hall near the origin.
