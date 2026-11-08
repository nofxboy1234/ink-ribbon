# The RPD item registry

The RPD sokol map owns every MapGenie B1-4F marker as one registry row. A row
joins the mapped world pose, the extracted 3D model, the icon and the typed
action, so no code path branches on a hand-written item name.

## Build

```
python3 tools/build_item_registry.py --map-json /tmp/mapgenie/map-878.json
node tools/gen_item_registry.mjs
```

The first command writes `public/rpd/item_registry.json`. It joins
`items_mapgenie.json`, `item_models.json` and `icons.json` by title and
category slug, and reads the MapGenie descriptions for the relations. The
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
  "model": null,
  "icon": "lock",
  "action": "open",
  "requires": [544635],
  "requires_open": [],
  "contents": [545843],
  "opens": [],
  "hidden_by": null
}
```

`requires` are item rows that must be carried in one of the eight inventory
slots before the action is allowed. `requires_open` are fixtures that must be
open or unlocked first. `contents` are revealed when this row opens or is
solved; each content row starts with `hidden_by` pointing back at its container.
`opens` is the reverse index, filled from both the `**Unlocks:**` sections and
the `**Unlocked By:**` links so a key knows what it opens.

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
  coordinate, so the 87 off-nav markers and the 72 off-floor/door/stair markers
  stay interactable. Those rows keep `placement: "fixture"`; they render at the
  mapped spot with the same transform.
- Modelled rows draw the extracted mesh in perspective and on their own floor
  in ortho. A model scales by `metres_per_unit` clamped to 0.55-1.6 m so keys
  stay readable at building scale. The model pivot is the manifest base centre,
  so the mesh sits on the floor surface.
- Perspective culls a model below roughly two pixels and by the view frustum.
  Ortho draws only the active floor. The unmodelled fixtures keep a 3D marker
  in perspective and a coloured diamond in ortho; modelled rows draw as meshes
  in both views, and the icons remain the inventory and popup identity.
- Item pixels carry normal alpha 0.5, the marker alpha the composite already
  understands, so a small model keeps its albedo instead of becoming an ink
  silhouette.

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

Links that point outside the RPD marker set stay in `unresolved` rather than
being dropped, for example the Underground Facility case opened by the
S.T.A.R.S Badge, and the Sewers Hiding Place film.

## Known gaps

- Safe and dial-lock combinations are flavour: the open action does not require
  the combination file, because the API carries the code as prose and not as an
  item relation.
- The one-way doors, chained doors with no parsed key, and cut rooms stay
  `none`. They render but offer no action.
- Film processing is not modelled as a state change. Files tied to a film are
  `hidden_by` their container only when the API links the container; a film in
  the inventory does not unlock a redirect.
