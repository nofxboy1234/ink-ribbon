# Entrance map

A C11 + sokol recreation of the R.P.D. Entrance map overlay from the reference clip. It draws a T-shaped floor plan with a bone outline, a fixed-size player chevron with a soft expanding glow, a virtual analog stick centered on the player, the Locked Door tooltip, zoom, reset, and the search status legend. The background is black. The 3D game scene, the top header, the icon row, and the objective text are not rendered.

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

- Move the pointer into the white circle around the player. The visible cursor is clamped to the circle.
- The white line shows the stick direction. The green line shows the stick length and movement speed.
- Inside the inner half-radius ring the player walks. Outside it the player runs. The speed change is accelerated rather than instant.
- Hold left mouse to turn in the green direction. The turn rate scales with the green line length and with the angle away from straight up. Straight up means no turn. Holding an off-axis direction produces a complete turning circle. Holding left while running rotates at the run turn rate and keeps the run speed.
- Release left mouse to keep the current facing and strafe or backpedal in the green direction.
- Scroll to zoom around the player. Press `R` to reset the zoom and recenter on the player.

The camera follows the player, so the stick stays centered on the player and the map moves underneath. The FPS counter sits in the top right in green. The wheel range extends below and above the default zoom.

## Movement

The green line is the stick direction and speed. Without left mouse it is the left-stick movement, so the facing holds and the player strafes or backpedals. With left mouse held it is the right-stick camera turn, so the player keeps moving forward along its heading while that heading rotates. Holding the green line still and off-axis produces a complete turning circle. The green length controls the turn rate, and crossing the half-radius threshold changes the speed target from walking to running. The green line straight up means no turn.

The player body collides with the map walls and slides along them. The collision radius follows the fixed-size marker, so it is about 29 world units at the default zoom and grows as the map zooms out.

## Layout

The map viewport has no panel or top chrome. The legend and control hint sit underneath the map on the black background. The legend shows Currently Searching in red and Search Completed in blue, matching the map overlay.

## Assets

The map, doors, player chevron, expanding glow, cursor, tooltip panel, and legend squares are authored in Krita. The chevron keeps a fixed screen size as the map zooms. The glow expands and fades like a soft puddle rather than breathing. The joystick circles, direction line, and speed line are drawn directly with sokol primitives. The `.kra` sources are in `assets/src`, the exported PNGs are in `assets`, and `assets/src/build_assets.py` redraws them. Regenerate everything with:

```sh
./tools/build-assets.sh
```

The script needs Krita, `kritarunner`, and `xvfb-run`.

The map and sprite textures upload a CPU mip chain with `num_mipmaps` and linear mip filtering. This keeps the baked room label smooth at the minimum zoom. The vendored sokol headers match the current `floooh/sokol` default branch, commit `93aa187` from 2026-11-10.

## Verification

`tools/verify.sh` builds the app, runs it under Xvfb, drives the pointer and left button, and saves screenshots to `verification/shots`. It checks stick engagement, the walk and run thresholds, turn-rate scaling, a full run turning circle, strafing, camera follow, zoom range, and the frame log movement states. It needs `xvfb-run`, `xdotool`, ImageMagick, and Python 3.

## License

The project code is MIT licensed. See `LICENSE`.
