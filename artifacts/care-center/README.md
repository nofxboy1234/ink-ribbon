# Care Center map

The Care Center map is authored entirely inside the Sokol map's built-in level
editor. There is no external art pipeline: `native/assets/scene.bin` is the
committed source of truth, and the Rust baker (`native/src/bake.rs`) turns it
into the overlay texture, navigation/collision grids and stair/item data at
startup.

## First area (draft)

The committed scene is a first draft of a Resident-Evil-Requiem-style opening on
Floor 1: a "Lobby" room split by a partition, holding a typewriter, an item box
and the Ward Key. The Ward Key opens a locked door in the partition into
"Containment", which is a fog region revealed by that door; an Ink Ribbon waits
inside. Walk into it to see the fog lift, the door turn blue and the goal list
update.

## Editing

Open the map, press **Tab** to enter edit mode, and use the in-canvas tool bar:

- **SELECT** — click to select, drag to move, corner handles to scale, the top
  handle to rotate boxes. Shift-click adds to the selection.
- **WALL+ / WALL-** — drag rectangles; a rectangle is a room (walkable inside,
  its wall drawn as a double line). Overlapping rooms union, so shared walls
  vanish. `WALL-` carves a notch out of the union (an enclosed carve keeps the
  room floor and reads as an alcove; an open carve is a hole).
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
- **PLAYER** — click to set the player's initial spawn point (one per map). The
  marker is editor-only (not drawn or collected in play) and the player starts
  with the arrow centred on it, as does NEW RUN.
- **NAME** — click to drop a room name label; **R** renames it, drag to move.
  Labels scale with the map zoom (they are not fixed screen-size like item icons).
- **ROOM** — drag a fog-of-war region. A region owns the geometry whose centre it
  contains (smallest region wins), so draw it to cover a room and its walls. New
  regions start Hidden; select one and press **H** to toggle Hidden/Revealed, and
  **R** to rename it.
- **TRIG** — drag a reveal trigger area. Walking into it fires once.
- **LINK** (or `C`) — click a door, key item or trigger and then a region to make
  it reveal that region (and vice versa). Doors work either order with keys too.
- **ERASE** — click near an object to delete it.

Keys: `Z` undo, `X` clear floor, `S` save, `L` load, `Space` snap, `Del` delete,
`Ctrl+C/V/D` copy/paste/duplicate, `H` toggle region visibility, `Tab`/`Esc` exit.

Fog of war: a Hidden region is neither drawn nor walkable. Revealing it (a linked
door unlocking/revealing, a picked-up item, or a trigger) adds its geometry back
and re-bakes. Until the player enters a region its floor has no background (it is
erased back to the page); once visited it renders as a normal room floor.

In play mode the map is turn-based: click (or tap) a highlighted cell to spend a
turn moving there — walk up to 6 cells, run up to 10. Reachable cells are shaded
soft blue and a rope previews the route under the cursor. `Esc` opens/closes the
pause menu, `I` toggles the inventory (`Esc` closes it), `B` opens the item box
(storage on the left, inventory on the right; arrows select, `Space` or clicking
an item moves it across, `Esc` closes), and `Space` interacts (unlock a linked
door, or save at a typewriter when holding an ink-ribbon), spending the turn.
Arrow keys navigate menus, the inventory and confirmation prompts. The web shell
shows live STEPS/TURN counters, a NEW RUN button, and a GOALS list: click a goal
to draw its route (green to the reachable point, red past a locked door or
unrevealed area) and toggle it with HIDE/SHOW ROUTE.

Saving writes `scene.bin` (native: working directory; web: `localStorage`, which
auto-loads next time). In the web shell, save with `S` in the editor and use the
**scene.bin** footer button to download the file for committing.

Map artwork belongs to its respective rights holders.
