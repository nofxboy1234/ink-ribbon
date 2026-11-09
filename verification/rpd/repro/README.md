# Wall-clip repro

The route runs from Main Hall to the east hallway on the 1F plan. It was
captured in the browser with the real app and CDP.

Before the fix, the route cuts the L-shaped wall below East Hallway 1F and
the orange item cell. The 3D shot follows the same line through the wall.
After the fix, the line rounds the wall corner and passes the item cell.

The rerunnable proof is `window.__quest.checkPath().clearance` in
`tools/verify_rpd.mjs`. On the contract route the old engine reports
`-0.245 m` and the fixed engine reports `0.033 m` at the route body radius of
`0.25 m`. The capsule marker itself uses the restored `0.425 m` radius.

`tools/verify_rpd.mjs` also samples the route against the rendered wall boxes
from `public/rpd/plan.json`. On the contract route the current engine reports
`0` penetrating samples and a minimum body clearance of `0.323 m` against the
`0.425 m` capsule. The paper plan narrows to about `0.62 m` at a few doorways,
so the visual capsule can graze a door frame there; the route body and the
drawn line do not enter a wall.

`tools/rpd_wall_openings.mjs` splits a rendered wall box wherever a flat nav
edge crosses it. That is what keeps the rendered plan and the navigation graph
in agreement, including the L-shaped wall in this repro.

`route-plan-before-after.png` is the left/right plan comparison.
`before-route-clip-0.png` and `after-route-clip-0.png` are the perspective
views of the same route.
