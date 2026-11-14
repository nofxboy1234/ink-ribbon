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

- Middle-drag inside the map to pan.
- Scroll inside the map to zoom around the pointer.
- Click inside the Entrance room to move the player chevron. It turns toward the click and eases to a stop.
- Hover the red door to see the Locked Door tooltip.
- Press `R` to reset the view and flash the player.

The FPS counter sits in the top right in green.

## Layout

The map viewport has no panel or top chrome. The legend and control hint sit underneath the map on the black background. The legend shows Currently Searching in red and Search Completed in blue, matching the map overlay.

## Assets

The map, doors, player chevron, glow, pulse, cursor, tooltip panel, and legend squares are authored in Krita. The `.kra` sources are in `assets/src`, the exported PNGs are in `assets`, and `assets/src/build_assets.py` redraws them. Regenerate everything with:

```sh
./tools/build-assets.sh
```

The script needs Krita, `kritarunner`, and `xvfb-run`.

## Verification

`tools/verify.sh` builds the app, runs it under Xvfb, drives the pointer and keyboard, and saves screenshots to `verification/shots`. It needs `xvfb-run`, `xdotool`, and ImageMagick.

## License

The project code is MIT licensed. See `LICENSE`.

## Third-party code and fonts

See `THIRD_PARTY_NOTICES.md`. Sokol, fontstash, and stb are vendored under `vendor/`. Roboto and Roboto Condensed are under the Apache License 2.0 in `assets/fonts/LICENSE-RobotoCondensed.txt`.
