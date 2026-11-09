# The RPD item registry

The RPD sokol map owns every MapGenie B1-4F marker as one registry row, plus
the Car Key box that MapGenie describes but does not plot. A row joins the
mapped world pose, the icon and the typed action, so no code path branches on a
hand-written item name. The registry has 271 rows.

## Build

```
python3 tools/build_item_registry.py --map-json /tmp/mapgenie/map-878.json
node tools/gen_item_registry.mjs
```

The first command writes `public/rpd/item_registry.json`. It joins
`items_mapgenie.json` and `icons.json` by title and category slug, and reads
the MapGenie descriptions for the relations. The
second command writes `native/gen/rpd_item_registry.h`, which `native/build.sh`
regenerates on every wasm build. The JSON is committed; the C header is not.

## Row shape

```json
{
  "id": 545844,
  "title": "Car Trunk",
  "category": "Lock",
  "category_slug": "lock",
  "floor": 4,
  "x": -0.295, "y": -5.2, "z": 34.387,
  "placement": "fixture",
  "icon": "lock",
  "action": "open",
  "requires": [544635],
  "requires_open": [],
  "contents": [545843],
  "opens": [],
  "hidden_by": null,
  "blocks": false,
  "code": null,
  "external_requires": [],
  "external_grants": [],
  "hint": [],
  "unreachable_reason": null,
  "synthetic": false
}
```

`requires` are item rows that must be carried in one of the eight inventory
slots before the action is allowed. `requires_open` are fixtures that must be
open or unlocked first. `contents` are revealed when this row opens or is
solved; each content row starts with `hidden_by` pointing back at its container.
`opens` is the reverse index, filled from both the `**Unlocks:**` sections and
the `**Unlocked By:**` links so a key knows what it opens.

`blocks` marks a door that closes the nav graph at its threshold cells until
its state is open, unlocked or used. `block_radius` is 2.0 m and lives at the
top of the registry, so a locked door shuts the adjacent cell as well as the
threshold. `code` is the MapGenie prose code for a safe or dial lock. `hint`
names the file or note that must be read or carried before the code is accepted.
`external_requires` lists a carrying requirement from outside the mapped
floors, such as the Sewers Hiding Place film. `external_grants` marks the
reachable map action that fetches such an item, so the film is obtained from the
Underground Facility transition rather than a DEV grant. `unreachable_reason`
records a pickup that the nav graph cannot reach, so `npm run check:items`
reports it instead of losing it. `synthetic` marks the authored Car Key box.

## Action kinds

| Action | Categories | Slot | State on success |
|---|---|---|---|
| `take` | key items, ammo, herbs, weapons, film, upgrades | one | `TAKEN` |
| `unlock` | locks with a key or tool gate | none | `UNLOCKED` |
| `open` | safes, item boxes, car trunk, dial lock | none | `OPEN` |
| `solve` | puzzles | none | `OPEN` |
| `read` | files and area maps | none | `READ` |
| `use` | typewriters, sinks, gear boxes, levers | none | `USED` |
| `inspect` | Mr Raccoon, Easter egg | none | `INSPECTED` |
| `none` | transitions, windows, one-way locks, cut content | none | stays present |

Keys are ordinary carryables and compete for the same eight slots as ammo and
herbs. The inventory refuses a ninth pickup with `INVENTORY FULL`, and a lock
whose key is not in a slot stays shut with `<KEY> - NEEDS KEY` disabled.

## World rules

- Coordinates are the MapGenie mapped `x/y/z`, with `y` as the floor surface.
  Nothing snaps to a nav node. `items_place` only records the nearest node per
  floor as the walk-next target.
- Items never block the nav graph. Reach is a 2.5 m distance to the item
  coordinate, or 1.5 m to the row's walk-next node, so the off-nav markers stay
  interactable. Those rows keep `placement: "fixture"`; they render at the
  mapped spot with the same transform.
- A locked door blocks every nav node within `block_radius` of its mapped
  pose on its floor. The obstacle clears when `items_act` moves the door to
  `UNLOCKED` or `OPEN`. While the door is closed, its walk-next target moves to
  the nearest open cell, so Claire can stand outside the threshold and turn the
  lock. A door whose threshold cells have no open node within 8 m stays
  unreachable and is reported by `npm run check:items`.
- The code locks open through the React code panel. The panel appears when the
  item popup opens on a safe or dial lock. `items_enter_code` refuses the code
  with `-7` until the linked `hint` item is read, used or carried, then accepts
  the exact MapGenie string. `npm run check:items` proves every hint is itself
  obtainable.
- The Hiding Place film is fetched from the mapped `To Underground Facility`
  transition. `items_act` records the external film, so the Hiding Place file
  reads without a DEV call. `npm run check:items` requires every external
  requirement to have a reachable granting action.
- Every present row draws a small cube in perspective and a coloured diamond
  in ortho. The cube colour is the category colour in `rpd_items.c`; key items
  are purple. Ortho draws only the active floor.
- The inventory draws each carried row as a solid square in the same cube
  colour. The icon id stays in the registry for the popup and the item API.

## Link derivation

`tools/build_item_registry.py` reads each MapGenie description and classifies
every `locationIds=` link by its bold section or the words before the link:

- `Unlocked By` / `Repaired with` -> `requires`, or `requires_open` when the
  target is a fixture rather than a carryable.
- `Contents` and `receive a [X]` -> `contents` plus `hidden_by` on X.
- `Inside the [X]` -> `hidden_by` X, and X gains the row in `contents`.
- `Unlocks` / `Used To` on a carryable -> the target gains `requires` and the
  source gains `opens`.
- `Obtained when [X] is solved` -> X gains the row in `contents`.
- `Obtained when the [Film] is processed in the [Darkroom Sink]` -> the file
  gains the film in `requires`, the sink in `requires_open` and the sink in
  `hidden_by`. The sink gains the file in `contents`, so using the sink reveals
  the file and the film must still be carried to read it. A film outside the
  marker set goes in `external_requires`.
- A dial lock's `**Unlocked By:** C-A-P` line and a safe's `Combination:`
  bullets become `code`, with the bullets written as `L9 R15 L7`.
- A `**Hint:**` link becomes `hint`, the file or note that makes the code
  readable.
- `One-Way Door` and a description that says it cannot be opened while playing
  as Claire stay `none`. Claire A cannot use those locks, so they never become
  an action.

The prose does not link three relations, so the builder authors them in
`MANUAL_RELATIONS`, `MANUAL_EXTERNAL_GRANTS` and `MANUAL_UNREACHABLE`:
`High-Capacity Mag. (MQ 11)` needs the Hiding Place file open, `To Underground
Facility` fetches the Sewers film, and the two 1F east-wing herbs plus the 1F
service-room Valve Handle are recorded as unreachable.

Links that point outside the RPD marker set stay in `unresolved` rather than
being dropped, for example the Underground Facility case opened by the
S.T.A.R.S Badge. A film outside the marker set goes in `external_requires`
instead, and a mapped transition grants it through `external_grants`.

## Known gaps

- The two 1F east-wing herbs at (44.3, -29.2) sit in a wing clipped by the plan
  edge. The pre-rebase graph reached them only through a cross-floor teleport
  edge, so they are marked unreachable rather than faked into the walkable
  component. `npm run check:items` fails if a marked item becomes reachable and
  if an unmarked pickup is not.
- The 1F service-room Valve Handle is sealed behind a thin plan wall. Its
  dependent `Valve` and `One-Way Door` fixtures stay present without a route.
- The B1 kennel threshold is a dotted plan line rather than wall ink. The nav
  builder adds one explicit bridge at (-17.5, 13.5) to (-17.5, 15.5), so the
  B1 herb at (-8.2, 9.5) stays obtainable.
- The one-way doors and the Claire-only doors stay `none`. Claire A cannot use
  them, so they render without an action and never block a route.
