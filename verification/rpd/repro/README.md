# Wall-clip repro

The route runs from Main Hall to the east hallway on the 1F plan. It was
captured in the browser with the real app and CDP.

Before the fix, the route cuts the L-shaped wall below East Hallway 1F and
the orange item cell. The 3D shot follows the same line through the wall.
After the fix, the line rounds the wall corner and passes the item cell.

The rerunnable proof is `window.__quest.checkPath().clearance` in
`tools/verify_rpd.mjs`. On the contract route the old engine reports
`-0.245 m` and the fixed engine reports `0.033 m`, with
`radius` `0.25 m`.

`route-plan-before-after.png` is the left/right plan comparison.
`before-route-clip-0.png` and `after-route-clip-0.png` are the perspective
views of the same route.
