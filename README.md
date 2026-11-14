# Entrance map

A C11 + sokol recreation of the R.P.D. Entrance map overlay from the reference clip. It draws a T-shaped floor plan with a bone outline, a fixed-size player chevron with a soft expanding glow, WASD movement with a latched walk/run state, the Locked Door tooltip, zoom, reset, and the search status legend. The background is black. The 3D game scene, the top header, the icon row, and the objective text are not rendered.

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

- WASD moves the player. The camera follows, so the player stays at the screen center and the map moves underneath.
- Walking keeps the current facing. A, S, and D strafe and backpedal relative to that facing.
- Right-click toggles the walk/run latch. The latch persists until the next right-click. The walk speed is 125 and the run speed is 250.
- Running turns the heading toward the WASD movement direction at the run turn rate. The player moves along that heading, so a direction change carves a turning circle.
- Scroll to zoom around the player. Press `R` to reset the zoom and recenter on the player.
- Hover the red door with the free cursor to see the Locked Door tooltip.

The FPS counter sits in the top right in green. The map opens at the zoomed-out overview, and the wheel range extends below and above that default.

## Movement

The walking branch moves directly in the WASD direction without changing the heading. The running branch steers the heading toward the WASD direction with the existing 5.5 radian per second turn rate, then moves along the heading. At 250 speed that is about a 45.5 unit turning radius. The speed change between the two states uses the existing acceleration.

The player body collides with the map walls and slides along them. The collision radius follows the fixed-size marker, so it is about 29 world units at the default zoom and grows as the map zooms out.

## Layout

The map viewport has no panel or top chrome. The legend and control hint sit underneath the map on the black background. The legend shows Currently Searching in red and Search Completed in blue, matching the map overlay.

## Assets

The map, doors, player chevron, expanding glow, cursor, tooltip panel, and legend squares are authored in Krita. The chevron keeps a fixed screen size as the map zooms. The glow expands and fades like a soft puddle rather than breathing. The free ring cursor uses tapered cardinal guides. The `.kra` sources are in `assets/src`, the exported PNGs are in `assets`, and `assets/src/build_assets.py` redraws them. Regenerate everything with:

```sh
./tools/build-assets.sh
```

The script needs Krita, `kritarunner`, and `xvfb-run`.

The map and sprite textures upload a CPU mip chain with `num_mipmaps` and linear mip filtering. This keeps the baked room label smooth at the minimum zoom. The vendored sokol headers match the current `floooh/sokol` default branch, commit `93aa187` from 2026-11-10.

## Verification

`tools/verify.sh` builds the app, runs it under Xvfb, drives WASD and the right-click latch, and saves screenshots to `verification/shots`. It checks the walking strafe and backpedal, the run latch, the running turn, camera follow, the free cursor, the absence of the old analog ring, the zoom range, the frame log movement states, and a clean close through the Escape quit path. It needs `xvfb-run`, `xdotool`, ImageMagick, and Python 3.

## License

The project code is MIT licensed. See `LICENSE`.
