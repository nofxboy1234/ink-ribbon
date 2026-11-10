# Acceptance playthrough

## Sub-features

One deterministic session that collects the 116 obtainable items, preloads the 3 unreachable items into the global item box at the start, manages the 8-slot inventory through the box, exercises save/load, the menus and the item actions, opens the B1 garage door with the keycard and fades to black. The same session is recorded twice, once in ortho and once in perspective, with time-lapse walking and real-time item and menu moments.

## How to get to it (user POV)

Start a new game. The item box holds the 3 unreachable items. Walk the route, take the items, store and withdraw through the item box, save and load at a typewriter, open the garage door with the keycard, and watch the fade.

## Driving it with the contract

- The replay harness: the scripted session replayed against the real app and wasm, with a fixed clock and state assertions.
- The final state: the collected count, the inventory, the item box contents, the three save slots, the doors, the keycard, the garage door and the fade.
- The evidence: the two GIFs, the replay data, the coverage matrix, the final-state report and a cold rerun from a clean checkout.

## Gotchas

The systems this journey needs do not exist yet: save/load, item box storage, the shared box, the door states and animation, the enemies, the combat, the health, the notes, the crafting, the debug mode, the teleport squares, the run toggle and the pause. The agreed plan is to build all of them first. Until then this journey reports a failure and names the missing precondition instead of weakening the run. The collection uses the 116 obtainable set plus the 3 unreachable preloaded into the box.
