# Route menu

## Sub-features

The sokol right-click menu in ortho with Add waypoint, Remove waypoint, Execute route and Clear all. One waypoint per nav cell. Remove targets the right-clicked cell. Route planning is ortho only. A route avoids item cells. A right drag still rotates the 3D camera.

## How to get to it (user POV)

In the 2D plan, right-click a walkable cell. The menu opens at the cursor. Add a waypoint, right-click the same cell to remove it, right-click a waypoint cell to run the route, or clear all.

## Driving it with the contract

- Right-click the canvas: `mousePressed` and `mouseReleased` with the right button.
- Assert the native menu state through `window.__quest.menu()` and the absence of a React `.rpd-menu`.
- Add, remove, execute and clear; assert `window.__quest.debug().waypoints` and `.moving`.
- The route check: `report.states.plan.check` with `points`, `samples`, `bad` and `clearance`.
- The item-cell block: the blocked item node and the detour route.

## Gotchas

The menu does not open in 3D. A right drag over 4 px rotates instead of opening. The open menu owns the pointer, so close it before probing an item hover. A menu click is a canvas coordinate, not a DOM click.
