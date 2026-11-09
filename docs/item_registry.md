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
its state is open, unlocked or used. `block_radius` is 1.0 m and lives at the
top of the registry. `code` is the MapGenie prose code for a safe or dial lock.
`external_requires` lists a carrying requirement from outside the mapped
floors, such as the Sewers Hiding Place film. `synthetic` marks the authored
Car Key box.

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
- `One-Way Door` and a description that says it cannot be opened while playing
  as Claire stay `none`. Claire A cannot use those locks, so they never become
  an action.

Links that point outside the RPD marker set stay in `unresolved` rather than
being dropped, for example the Underground Facility case opened by the
S.T.A.R.S Badge. A film outside the marker set goes in `external_requires`
instead, and `rpd_item_grant_external` records it as carried.

## Known gaps

- Safe and dial-lock codes are enforced through the DEV entry
  `rpd_item_enter_code`, not a keypad UI. `items_act` refuses a coded lock with
  `-5`, a wrong code returns `-6`, and a matching code opens the lock and
  reveals its contents. The verification run checks both outcomes.
- The one-way doors and the Claire-only doors stay `none`. Claire A cannot use
  them, so they render without an action and never block a route.
- The 1F Darkroom chain is a real state change. A file stays hidden until the
  sink is used, and reading it requires the matching film in a slot. The
  Hiding Place film is in the Sewers, so `external_requires` records it and the
  DEV grant stands in for carrying it across areas.
- The 1F Chained Door at (30.0, 1.4) sits in a two-node nav pocket with no open
  cell within 8 m. It is marked as a blocker but can never be unlocked from the
  route graph. `npm run check:items` reports it as a warning and still proves
  every gate key that a reachable gate needs.
