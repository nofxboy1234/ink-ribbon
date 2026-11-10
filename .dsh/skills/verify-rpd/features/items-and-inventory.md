# Items and inventory

## Sub-features

The 271 item markers, the type-coloured cubes, the hover name, the 8-slot inventory with coloured slots, the item popup and the take, unlock, open, use, read, solve and inspect actions, the key/lock gates and the item reachability.

## How to get to it (user POV)

Hover an item cube to see its name. Click it to act. Keys must be in the inventory for a lock to open. The inventory shows the carried items as coloured squares.

## Driving it with the contract

- `window.__quest.items()` for the 271 items; `window.__quest.itemByName("Spade Key")` for one.
- `window.__quest.actItem(index)` for an action; assert the returned code and the new state.
- `window.__quest.enterCode(code)` for a code lock; `grantExternal` for the external grants.
- The inventory DOM slots; the item title and the coloured square.
- `npm run check:items` for the reachability and the gate model.

## Gotchas

Three items are unreachable from the current plan, the 1F east-wing Green Herbs and the Valve Handle. The item box storage does not exist yet, so the inventory can fill. The inventory is eight slots. An item cell blocks the route, and taking the item frees it.
