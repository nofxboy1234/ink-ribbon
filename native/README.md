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
2. **Solid geometry** — all chunks are expanded into one interleaved
   position+colour vertex buffer and one `u32` index buffer, then drawn in a
   single call. The fragment shader derives face normals from screen-space
   derivatives, flips them toward the camera, and applies a key/fill/hemisphere
   light. There are no textures, no wireframe edges and no bloom.
3. **Composite to the swapchain** — a fullscreen triangle samples the offscreen
   colour, adds a restrained radial background gradient, vignette and a little
   grain. In blockout mode every material colour is mapped to a pastel tint.

There is one draw range for the whole building; the asset's per-floor records
are informational only.

## Input

`sapp_event` handles mouse orbit/pan/zoom, one- and two-finger touch, and `R` to
reset the camera. Drag scale is derived from the camera distance and the
vertical FOV so a pixel of drag maps to a constant world distance.

Holding the right mouse button enters a free-fly camera seeded from the current
orbit eye and orientation:

- mouse movement looks around;
- `W`/`S` move along the view direction, `A`/`D` strafe horizontally;
- `E` moves up and `Q` moves down;
- the scroll wheel adjusts fly speed (22 m/s default, 2–140 m/s range).

Releasing the right button converts the current eye/orientation back into the
orbit camera (target placed one orbit distance ahead), so the view does not
jump. `fly_begin`/`fly_end` live next to `camera_eye` in `main.c`.

## Camera

- Perspective, 0.62 rad vertical FOV.
- Default yaw −0.55 rad, pitch 0.62 rad.
- Distance is 150 units on a 1600 px canvas, scaled up on narrower viewports;
  it is recomputed on resize until the user moves the camera.
- Target is the X/Z centre of the scene bounds with Y at 40% of the height
  range.

The asset is in metres, Y-up, with the RPD main hall near the origin.
