# Entrance map

A C11 + sokol recreation of the R.P.D. Entrance map overlay from the reference clip. It draws a T-shaped floor plan with a bone outline, the glowing player chevron, a custom ring cursor, the Locked Door tooltip, smooth zoom and pan, reset, and the search status legend. The background is black. The 3D game scene, the top header, the icon row, and the objective text are not rendered.

![Entrance map](docs/preview.png)

## Build

You need CMake, a C11 compiler, OpenGL, and the X11 development headers (Xlib, Xi, Xcursor).

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
./build/entrance_map
```

The build copies `assets/fonts` next to the executable. To run from another directory, set `MAP_ASSETS` to the absolute path of the `assets` directory.

## Controls

- Drag inside the map to pan.
- Scroll inside the map to zoom around the pointer.
- Click inside the Entrance room to move the player chevron. It turns toward the click and moves with easing.
- Hover the red door to see the Locked Door tooltip.
- Press `R` to reset the view and flash the player.

## Layout

The map viewport has no panel or top chrome. The legend and control hint sit underneath the map on the black background. The legend shows Currently Searching in red and Search Completed in blue, matching the map overlay.

## Verification

`tools/verify.sh` builds the app, runs it under Xvfb, drives the pointer and keyboard, and saves screenshots to `verification/shots`. It needs `xvfb-run`, `xdotool`, and ImageMagick.

## License

The project code is MIT licensed. See `LICENSE`.

## Third-party code and fonts

See `THIRD_PARTY_NOTICES.md`. Sokol and fontstash are vendored under `vendor/`. Noto Sans is under the SIL Open Font License in `assets/fonts/OFL.txt`.
