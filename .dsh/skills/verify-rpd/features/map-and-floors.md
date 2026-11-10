# Map and floors

## Sub-features

The paper 3D view, the glass 3D floors, the ortho 2D plan, the 4F/3F/2F/1F/B1 floor selector, the 3D toggle, wheel zoom, the item cubes, the item hover name and the legend.

## How to get to it (user POV)

The app opens on the map. Use the floor buttons to change floor, the 3D button to toggle the perspective, the mouse wheel to zoom, and hover an item cube to see its name.

## Driving it with the contract

- The floor button: click the button with the floor label; assert `window.__quest.debug().activeFloor` and the visible floor.
- The 3D toggle: click the 3D button; assert `window.__rpd.debugBlend()` reaches 0.999 for ortho or 0.001 for 3D.
- The zoom: `window.__quest.project` before and after the wheel; assert the projected item moves and the map stays centred.
- The item cubes: `window.__quest.items()` for the 271 items and `overlayStats()[0]` for the hovered index.
- The legend: assert the eight item colour labels in the DOM.

## Gotchas

The ortho zoom must survive a floor change and a cross-floor walk. The item cube size is constant in ortho and world-scaled in 3D. The paper/glass style is separate from the floor that is visible.
