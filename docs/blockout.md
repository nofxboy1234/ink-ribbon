# Whole-RPD blockout

A simplified Blender model of the Raccoon Police Department, floors 1 to 3,
built from the decompiled level meshes. Every primitive sits on coordinates
taken from the source geometry. Nothing is traced from a map or placed by eye.

The model is a dollhouse blockout. It has floor plates, walls with full-height
door and window gaps, square pillars, stair wedges and ramp slabs. It has no
roofs, ceilings, furniture, railings, statue or other props.

![Floor 1 blockout](blockout-f1.jpg)

![Main hall blockout](blockout-hall.jpg)

## What is generated

```
build/rpd_blockout.blend        Blender scene, source meshes as a wireframe reference
build/blockout/blockout.obj     blockout only, source coordinates, Y up
build/blockout/blockout.glb     same model, glTF Y-up
build/blockout/spec.json        every primitive and its source-derived coordinates
build/blockout/reference/       the decompiled meshes used as the reference
build/blockout/renders/         overview, main hall, and one render per floor
build/blockout/compare/         source-versus-blockout room renders
build/blockout/verify/          source-versus-blockout plan overlays and metrics
public/rpd/simple2.bin          blockout asset for the /simple2 page
public/rpd/simple2.json         blockout asset metadata
```

The current spec holds 35 floor slabs, 2,864 wall boxes, 64 pillars, 21 stair
wedges and 2 ramp slabs.

![RPD blockout at /simple2](blockout-app.jpg)

The web page at `/simple2` loads `public/rpd/simple2.bin`, converted from
`build/blockout/blockout.obj` by `tools/obj_to_simple.py`. `npm run blockout`
builds the asset as part of the pipeline. The asset keeps the source metres and
uses a 6 m padding on its framing bounds so the default camera shows the whole
blockout. The page is `pages/simple2.tsx`.

The `.blend` scene has two collections:

- `RPD_Blockout`, with `F1`, `F2` and `F3`. Each floor has floor slabs, walls,
  pillars, stairs and ramps.
- `RPD_Reference`, with `Ref_F1`, `Ref_F2` and `Ref_F3`. These are the original
  LOD-0 triangles inside the RPD area, drawn as a wireframe and hidden from
  render. The reference keeps every triangle inside x -46 to 48, z -36 to 20
  and y -2 to 22, which covers the building and its immediate grounds.

Toggle the reference collection to check the blockout against the source.

## Coordinates and scale

The game stores the level in metres with Y up. The blockout spec keeps that
space. The Blender scene is Z up and maps

```
blender = (x, -z, y)
```

The source triangle positions are used directly. No scale factor is applied.
The detected floor plates sit at the same heights as the source floors:

| Floor | Source floor levels (m) | Wall band (m) |
|---|---|---|
| 1 | 0.05, 0.75 | -1.2 to 4.6 |
| 2 | 5.25, 5.85 | 3.9 to 9.4 |
| 3 | 10.45, 14.03 | 9.2 to 14.8 |

The main hall stair flights rise from 0.75 to 5.25, matching the source
treads at x -7.36 to -3.89 and 3.99 to 7.36, z -15.36 to -8.79.

## How the primitives are derived

The extraction reads `data/raw/rpd/*.mesh` and uses the material name table in
each file. Material names are mapped through the per-file material index
remap at header offset `0x60` and the name table at `0x78`.

- **Floor plates.** Up-facing floor-material triangles are binned by height in
  10 cm slices. Peaks at least 0.8 percent of the floor area become plate
  levels. Each level is unioned in plan, small holes under 1.6 m2 are filled,
  and the outline is extruded 25 cm down. Split levels stay as separate plates.
- **Walls.** Vertical triangles from structural materials are grouped into
  planes on their dominant axis, with an 11 cm plane tolerance. Each plane is
  rasterized at 3 cm with real triangle coverage, not bounding boxes, so arch
  and doorway voids stay open. A run is solid when it covers the 1.0 to 2.0 m
  band. Door runs get a lintel above their opening, and window runs get a sill
  and a lintel. Both wall faces are kept as 0.16 m boxes, and the exterior
  police shell is included. Runs shorter than 0.25 m are dropped.
- **Pillars.** Pillar-material triangles are clustered in plan. A cluster is a
  pillar when its footprint is 0.2 to 2.1 m on a side, at least 1.5 m tall,
  and covers at least 4 percent of its bounding box. It becomes one box.
- **Stairs.** Two sources. Stair-material clusters get one wedge each. Stairs
  without stair materials are found as chains of small horizontal treads whose
  heights rise in 8 to 45 cm steps. The wedge runs from the lower floor level
  to the upper one.
- **Ramps.** Up-facing triangles with a tilted normal, a fitted plane residual
  under 9 cm, and a slope under 0.5 become thin sloped slabs.
- **Missing floors.** A second pass finds source floor plates not covered by a
  slab, groups them by height, and adds a slab at that level. Stair footprints
  are excluded, so the pass fills sunken rooms and split levels rather than
  covering stairs.
- **Missing flights.** A third pass looks for uncovered sloped or stepped
  surfaces outside the existing stair footprints and adds a wedge only when a
  tread chain is detected.

Two dimensions are blockout conventions rather than source measurements. A
wall face with no paired opposite face becomes a 0.16 m box, and a low wall is
capped at 0.95 m. Everything else uses source coordinates.

## Verify

```bash
npm run blockout
```

This regenerates `spec.json`, the reference PLYs, the Blender scene, the OBJ
and GLB, and the verification report. It does not render. To render the six
views:

```bash
npm run blockout-render
```

The render uses Blender Workbench for the plan-style views and Cycles for the
main hall, so the whole set finishes in about a minute.

The verification rasterizes the source and the blockout at 5 cm per pixel.
It reports source-versus-spec coverage per floor. A point counts as covered
when it lies within 8 cm of a floor surface, or 20 cm of a wall centreline.
The run fails, with a nonzero exit, when floor recall drops below 0.99, solid
wall precision below 0.85, solid wall recall below 0.90, wall footprint
precision or recall below 0.95, a floor level misses the independent source
estimate by 0.20 m, the bounds exceed the source by more than 0.50 m, a stair
wedge has no source tread, or a pillar or ramp has no source geometry.

Current result:

| Floor | Floor precision | Floor recall | Solid wall precision | Solid wall recall | Footprint precision | Footprint recall |
|---|---|---|---|---|---|---|
| 1 | 0.957 | 0.999 | 0.965 | 0.989 | 0.997 | 0.992 |
| 2 | 0.984 | 0.995 | 0.986 | 0.955 | 0.995 | 0.965 |
| 3 | 0.981 | 0.996 | 0.969 | 0.987 | 0.991 | 0.953 |

Floor precision is below 1 because the spec keeps floor slabs under stair
footprints while the source plate mask excludes those footprints. Floor recall
is the completeness number. The solid wall score is the mid-height wall band.
The footprint score compares every wall box and every source wall face in plan,
which is the wall-for-wall test. The remaining footprint gaps are mostly curved
apses, thin trim and short wall ends. The plan overlays in
`build/blockout/verify/plan_f*.png` show them directly.

The same run checks every spec floor level against an independent histogram of
the source floor surfaces. All spec levels match a source level within 0.20 m.
It also checks the spec bounds against the source structural bounds with a
0.50 m margin. The largest overshoot is 0.23 m at floor 1 x-max, from wall
thickness and rounding. The raw source histogram also picks up the short step
surfaces at 0.28 and 0.53 m, which is why its level list has extra entries.

![Floor 1 source versus blockout](blockout-plan-f1.jpg)

![Press room source versus blockout](blockout-compare.jpg)

Stair tread coverage, the share of source tread triangles whose height falls
inside the wedge:

| Floor 1 stair | Coverage |
|---|---|
| Main hall left | 1.000 |
| Main hall right | 0.976 |
| Entrance steps | 1.000 |
| West office | 1.000 |
| East service | 1.000 |
| Garage ramp | 0.965 |
| West stairwell | 0.753 |
| East stairwell | 0.750 |

The score counts every small up-facing triangle inside a stair footprint,
including landings and floor tiles. A low value is therefore a prompt to look,
not proof of a missing flight. The main hall, entrance, east service, garage
and floor-3 flights are covered. The 0.596 and 0.625 floor-2 values and the
0.600 floor-3 value are stairwells with landings inside the footprint. The
compare renders in `build/blockout/compare/` show the wedges in place.

## Compare rooms

```bash
npm run blockout-compare
```

This loads `build/rpd_blockout.blend`, renders the source and the blockout from
the same camera for 11 room and corridor views, and writes side-by-side and
50/50 overlay images under `build/blockout/compare/`. The camera positions are
derived from the source room floor polygons.

## Pillars and ramps

Every one of the 64 pillar boxes contains source vertical geometry. Every one
of the two ramp slabs contains source sloped geometry. The check is a
containment check, not an independent shape comparison, because the boxes are
fitted to the same source triangles.

## Half walls

Half-height walls are reported separately. Most of them are balcony parapets
and low partitions, and the source low-band mask also contains stair sides and
railings, so its recall is not a main-shape target.

| Floor | Half-wall precision | Half-wall recall |
|---|---|---|
| 1 | 0.916 | 0.277 |
| 2 | 0.801 | 0.109 |
| 3 | 0.548 | 0.135 |

## Limits

- No roofs or ceilings. The model is meant to be read from above.
- Door and window openings are full height. Lintels, sills and frames are
  omitted on purpose.
- Props, railings, furniture and the statue are not modeled.
- Curved arches and the main-hall apse are approximated by axis-aligned walls
  and rectangular openings. Decorative arches, ceilings, the statue and
  furniture are not modeled.
- Curved and diagonal walls are approximated by axis-aligned boxes. Walls
  shorter than 0.25 m and openings narrower than that are dropped.
- The garage levels below floor 1 are outside the blockout band.

## Rebuild from the game install

`data/raw/rpd/` is not committed. Recreate it first:

```bash
uv run --with zstandard python tools/extract_rpd.py
```

Then run `npm run blockout`. It writes the Blender scene, the `/simple2`
asset and the verification report. Blender 5.2 or newer is required. Open
`/simple2` after `npm run dev` to view the blockout in the app.
