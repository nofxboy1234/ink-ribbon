# Entrance map

A C11 + sokol recreation of the R.P.D. Entrance map overlay from the reference clip. It draws a T-shaped floor plan with a bone outline, a fixed-size player chevron with a soft expanding glow, cyan waypoint cells, a bright green route rope, a custom ring cursor, the Locked Door tooltip, smooth zoom and pan, reset, and the search status legend. The background is black. The 3D game scene, the top header, the icon row, and the objective text are not rendered.

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

- Middle-drag inside the map to pan. The map tracks the pointer directly, with no camera catch-up.
- Scroll inside the map to zoom around the pointer.
- Left-click inside the Entrance to walk to the point. Right-click to run. Each click appends a waypoint, and the chevron curves through the queue with preserved momentum.
- Double-click inside the map to cancel all movement.
- Moving the pointer extends a live green preview from the last waypoint to the pointer.
- Hover the red door to see the Locked Door tooltip.
- Press `R` to recenter on the player at the default zoom and flash the player.

The FPS counter sits in the top right in green. The map opens at the zoomed-out overview, and the wheel range extends below and above that default.

## Layout

The map viewport has no panel or top chrome. The legend and control hint sit underneath the map on the black background. The legend shows Currently Searching in red and Search Completed in blue, matching the map overlay.

## Assets

The map, doors, player chevron, expanding glow, cursor, tooltip panel, and legend squares are authored in Krita. The chevron keeps a fixed screen size as the map zooms. The glow expands and fades like a soft puddle rather than breathing. Clicked waypoints render as cyan squares at an 18-unit navigation-cell size, because there is no separate navigation grid. The `.kra` sources are in `assets/src`, the exported PNGs are in `assets`, and `assets/src/build_assets.py` redraws them. Regenerate everything with:

```sh
./tools/build-assets.sh
```

The script needs Krita, `kritarunner`, and `xvfb-run`.

The map and sprite textures upload a CPU mip chain with `num_mipmaps` and linear mip filtering. This keeps the baked room label smooth at the minimum zoom. The vendored sokol headers match the current `floooh/sokol` default branch, commit `93aa187` from 2026-11-10.

## Verification

`tools/verify.sh` builds the app, runs it under Xvfb, drives the pointer and keyboard, and saves screenshots to `verification/shots`. It needs `xvfb-run`, `xdotool`, and ImageMagick.

## License

The project code is MIT licensed. See `LICENSE`.

## Third-party code and fonts

See `THIRD_PARTY_NOTICES.md`. Sokol, fontstash, and stb are vendored under `vendor/`. Roboto and Roboto Condensed are under the Apache License 2.0 in `assets/fonts/LICENSE-RobotoCondensed.txt`.
