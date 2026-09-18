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
- **WALL+ / WALL-** — drag rectangles; overlapping add/subtract shapes build the
  wall mask.
- **OBST / LOCK / OPEN / UNK** — drag obstacle and door boxes.
- **STAIR** — click to drop a stair endpoint. Use **LINK** (or `C`) to connect
  two endpoints across floors.
- **ITEM** — click to drop a key item; **LINK** connects it to doors; **R**
  renames it.
- **ERASE** — click near an object to delete it.

Keys: `Z` undo, `X` clear floor, `S` save, `L` load, `Space` snap, `Del` delete,
`Ctrl+C/V/D` copy/paste/duplicate, `Tab`/`Esc` exit.

In play mode: `Esc` opens/closes the pause menu, `I` toggles the inventory
(`Esc` closes it), `Space` interacts (unlock a linked door, or save at a
typewriter when holding an ink-ribbon), and arrow keys navigate menus, the
inventory and confirmation prompts.

Saving writes `scene.bin` (native: working directory; web: download plus
`localStorage`, which auto-loads next time). Commit the resulting `scene.bin` to
publish the map.

Map artwork belongs to its respective rights holders.
