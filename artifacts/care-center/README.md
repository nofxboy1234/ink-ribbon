# Care Center map

The Care Center map is authored entirely inside the Sokol map's built-in level
editor. There is no external art pipeline: `native/assets/scene.bin` is the
committed source of truth, and the Rust baker (`native/src/bake.rs`) turns it
into the overlay texture, navigation/collision grids and stair/item data at
startup.

## Editing

Open the map, press **Tab** to enter edit mode, and use the in-canvas tool bar:

- **SELECT** — click to select, drag to move, corner handles to scale, the top
  handle to rotate boxes. Shift-click adds to the selection.
- **WALL+ / WALL-** — drag rectangles; a rectangle is a room (walkable inside,
  its wall drawn as a double line). Overlapping rooms union, so shared walls
  vanish. `WALL-` carves.
- **WALL** — drag a thin rectangle to place an interior partition inside a room;
  it renders dim on both lines and blocks.
- **LOCK / OPEN / UNK** — pick the door kind, then hover a wall: the snapped door
  prop previews where it will land; click to drop it into the wall. Doors are a
  fixed size and unlockable doors open the wall for movement.
- **OBST** — drag an obstacle box.
- **STAIR** — click to drop a stair endpoint. Use **LINK** (or `C`) to connect
  two endpoints across floors.
- **ITEM** — click to drop an item; **LINK** connects a key to doors; **R**
  renames it. The item popup sets the kind: KEY, INK RIBBON, TYPEWRITER (save
  point) or ITEM BOX (interact to open the storage).
- **NAME** — click to drop a room name label; **R** renames it, drag to move.
- **ERASE** — click near an object to delete it.

Keys: `Z` undo, `X` clear floor, `S` save, `L` load, `Space` snap, `Del` delete,
`Ctrl+C/V/D` copy/paste/duplicate, `Tab`/`Esc` exit.

In play mode the map is turn-based: click (or tap) a highlighted cell to spend a
turn moving there — walk up to 4 cells, run up to 7. Reachable cells are shaded
soft blue and a rope previews the route under the cursor. `Esc` opens/closes the
pause menu, `I` toggles the inventory (`Esc` closes it), `B` opens the item box
(storage on the left, inventory on the right; arrows select, `Space` or clicking
an item moves it across, `Esc` closes), and `Space` interacts (unlock a linked
door, or save at a typewriter when holding an ink-ribbon), spending the turn.
Arrow keys navigate menus, the inventory and confirmation prompts. The web shell
shows live STEPS/TURN counters and a NEW RUN button.

Saving writes `scene.bin` (native: working directory; web: download plus
`localStorage`, which auto-loads next time). Commit the resulting `scene.bin` to
publish the map.

Map artwork belongs to its respective rights holders.
