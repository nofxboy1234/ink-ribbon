# Extracting the RPD floors

Everything starts in `~/repos/reze`. Its README documents the RE2 RT install,
the `KPKA` v4 PAK, the Murmur3 path-hash lookup, and the existing asset tools.
This project reuses that knowledge but does not depend on the reze checkout at
runtime.

Source on this machine:

```
/home/dylan/.local/share/Steam/steamapps/common/RESIDENT EVIL 2  BIOHAZARD RE2
app id 883710   (ray-traced build, natives/stm tree)
```

## 1. Which PAK entries are the RPD?

`decompiled/pak/index.tsv` from reze lists 41,869 named entries. The RPD rooms
live under:

```
natives/stm/sectionroot/environment/location/st4_police/
```

The directory names encode the floors:

| Directory | Floor |
|---|---|
| `st4_1_policehall`, `st4_2_police1f_west`, `st4_3_police1f_east` | 1F |
| `st4_4_police2f_west`, `st4_5_police2f_east` | 2F |
| `st4_6_police3f` | 3F |

Each room (`st4_201_0`, `st4_313_0`, …) contains `*_occ.mesh`, `*_vocc.mesh`,
`*_terrain_00cr.rmesh` (collision) and `*_terrain_00ms.mesh.2109108288`. The
`00ms` mesh is the visible static level geometry. 49 rooms are selected and
stored in `tools/rpd_floor_meshes.txt`.

`tools/re_pak.py` computes the 64-bit path hash (Murmur3-32 over UTF-16LE lower
and upper names), scans the base PAK plus `patch_001`/`patch_002`, and
decompresses only the selected entries (raw DEFLATE or Zstandard).

```bash
uv run --with zstandard python tools/extract_rpd.py
# data/raw/rpd/st4_101_0.mesh ... (68.5 MB)
```

## 2. The `.mesh.2109108288` layout

The filename version is the public file version. The first u32 after the magic
is the internal version, `21041600`. All offsets below are for that variant.
This was derived from the mesh files and checked against NSACloud's
[RE Mesh Editor](https://github.com/NSACloud/RE-Mesh-Editor) (format reference
only; no addon code runs in this project).

### File header (`0x00`)

| Offset | Type | Meaning |
|---:|---|---|
| 0x00 | char[4] | `MESH` |
| 0x04 | u32 | internal version `21041600` |
| 0x08 | u32 | file size |
| 0x0c | u32 | LOD group name hash |
| 0x10 | u16 | content flag |
| 0x12 | s16 | name count |
| 0x14 | u32 | unknown |
| 0x18 | u64 | mesh group offset |
| 0x20 | u64 | shadow mesh group offset |
| 0x28 | u64 | occlusion mesh group offset |
| 0x30 | u64 | skeleton offset |
| 0x38 | u64 | normal recalc offset |
| 0x40 | u64 | blend shape offset |
| 0x48 | u64 | AABB offset |
| 0x50 | u64 | mesh buffer header offset |
| 0x58 | u64 | float data offset |
| 0x60 | u64 | material name remap offset |
| 0x68 | u64 | bone name remap offset |
| 0x70 | u64 | blend shape name offset |
| 0x78 | u64 | name offset table offset |

### Main mesh header at `meshGroupOffset`

```
u8  lod_group_count
u8  material_count
u8  uv_count
u8  skin_weight_count
u16 total_mesh_count
u8  has_32bit_index_buffer
u8  shared_lod_bits
f32 sphere[4]            // x, y, z, radius
f32 bbox_min[4]
f32 bbox_max[4]
u64 offset_offset
u64 lod_group_offsets[lod_group_count]
align 16
```

Each LOD group:

```
u8  count
u8  vertex_format
u16 reserved
f32 distance
u64 offset_offset
u64 mesh_group_offsets[count]
align 16
MeshGroup mesh_groups[count]
```

Each mesh group:

```
u8  viscon_group_id
u8  mesh_count
u16 null0, null1, null2
u32 vertex_count
u32 face_count
MaterialSubdivision subdivisions[mesh_count]
```

RE2 RT material subdivisions are 24 bytes:

```
u8  material_index
u8  is_quad
u8  vertex_buffer_index
u8  padding
u32 index_count
u32 index_start
u32 vertex_start
u32 streaming_offset_bytes
u32 streaming_platform_specific_offset
```

### Vertex/index buffers at `meshOffset`

```
u64 vertex_element_offset
u64 vertex_buffer_offset
u64 face_buffer_offset
u64 sunbreak_offset
u32 vertex_buffer_size
u32 face_buffer_size
u16 main_vertex_element_count
u16 vertex_element_count
u32 block2_face_buffer_offset
u32 null
s16 vertex_element_size
s16 unknown
u64 sunbreak_second_unknown
```

Vertex elements are 8 bytes: `u16 typing, u16 stride, u32 start`. Typing 0 is
position (`float3`, stride 12); typing 1 is normal+tangent (4 signed bytes each,
divide by 127); typing 2/3 are UV/UV2. Indices are 16-bit (`has_32bit` is 0 for
all RPD meshes).

### Two index-base gotchas

1. Each mesh group owns a `vertex_count` slice of the vertex buffer. The slice
   base is `min(submesh.vertex_start)` for the group.
2. Face indices are relative to the **subdivision's** vertex slice. In
   `remesh.triangles()`, the group-local offset is
   `submesh.vertex_start - group_base` and is added to every index. Without
   this, most submeshes produce a handful of triangles that stretch across the
   whole map.

`face_count`/`index_count` are counts of indices, not triangles. The triangle
count is `index_count / 3`. The 121,284-byte face buffer of room `st4_313_0`
therefore holds 20,213 triangles, not 60,642.

## 3. Floor-plan abstraction

The previous pass drew the raw triangle soup. This pass reduces it to what the
reference map actually communicates: room plates, wall runs and stairs. The
builder is `tools/build_plan.py`.

### 3.1 Read, clip and classify

LOD 0 is used from every room. Triangles are kept only if all vertices fall in
`[-60, -8, -40] … [55, 55, 30]`; this removes the distant RPD backdrop. Each
geometry class is then filtered:

- **Floor candidates:** upward-facing (`ny > 0.6`), 0.02–50 m², within the
  floor's Y window, and at least 1.6 m below the room's maximum Y (no ceilings
  or roofs).
- **Wall candidates:** near-vertical (`|ny| < 0.4`), 0.02–50 m², at least 1.6 m
  tall, with their bottom within 1.6 m of the floor base.
- **Stair candidates:** `0.2 < |ny| < 0.85`, 0.05–25 m², within 5 m above the
  floor base.

Giant terrain/backdrop triangles are excluded by the 50 m² cap. Without it,
rooms such as `st4_201_0`, `st4_504_0` and `st4_603_0` contribute 1,000–10,000
m² ground planes that swallow the building footprint.

### 3.2 Plates

The RPD's three main levels are at approximately **0.0 / 5.0 / 10.25 m**. The
builder uses one plate level per source floor group:

| Floor | Source rooms | Plate |
|---|---|---|
| 1F | `st4_1*`, `st4_2*`, `st4_3*` | 0.00 m |
| 2F | `st4_4*`, `st4_5*` | 5.00 m |
| 3F | `st4_6*` | 10.25 m |

For each room and level, horizontal triangles within ±1.5 m are filled into a
0.5 m occupancy raster. The mask is clipped, small components are dropped,
holes are filled, and components below 4 m² are removed. The 1F mask is clipped
to a building footprint derived from the 2F/3F room masks (dilated 1.5 m and
hole-filled) plus the main hall rectangle `x[-11,11], z[-23,13]`. This removes
the streets/plazas around the building.

Plates are emitted as **3 m fill tiles** where at least 45% of the underlying
0.5 m cells are covered. Tiles contribute only fill triangles; the visible 3 m
floor grid is generated in the fragment shader from world-space XZ coordinates,
so it costs no index-buffer space and fades naturally with distance.

### 3.3 Walls

Vertical triangles within 1.2 m of a plate level are projected onto the XZ
plane and drawn into a 0.5 m wall raster. The raster is dilated by one cell,
clipped to the floor mask, and **skeletonized** with
`skimage.morphology.skeletonize`. The one-pixel skeleton is then scanned for
horizontal and vertical runs of at least 1.5 m, and each run becomes a 4 m-tall
wall quad.

This is what turns the panel-by-panel wall geometry into continuous room and
corridor walls. Door openings survive as gaps in the skeleton; short jogs and
door frames are discarded. Curved walls are approximated by stair-stepped
runs at the 0.5 m grid.

### 3.4 Stairs

Sloped triangles in a floor's Y window are projected into the same 0.5 m raster
and grouped into components. A component becomes a simple staircase when it is
at least 1.2 m², has a horizontal run of 1.5 m, a width of 0.8 m, a height
difference of 0.9 m, and a footprint no larger than 90 m². The builder draws
4–14 tread and riser quads across the component's bounding rectangle. This is an
approximation, not a reconstruction of each step.

### 3.5 Renderer offsets

The final asset keeps the three plates at their real Y values. The sokol
renderer offsets 1F/2F/3F by 0 / 6 / 12 m respectively (`floor_offset` in
`native/main.c`) so the three plans read as an exploded axonometric.

**Result:** 1,790,053 source triangles → **2,224 triangles**, 2,306 vertices,
**1,593 edges**, 66 KB.

## 4. `rpd.bin` v2

```
0    char[4]  "RPDW"
4    u32      version = 2
8    u32      vertex_count
12   u32      triangle_count
16   u32      edge_count
20   u32      floor_count (3)
24   u32      reserved
28   f32[3]   bounds_min
40   f32[3]   bounds_max
52   floor[3] 24 bytes each:
       u32 tri_start
       u32 tri_count
       u32 edge_start
       u32 edge_count
       f32 y_min
       f32 y_max
124  f32[3]   positions[vertex_count]
     u32[3]   triangle_indices[triangle_count]
     u32[2]   edge_indices[edge_count]
```

`rpd.json` records the method, plate levels, per-floor areas/counts, and the
filter parameters.

## 5. Reproduce

```bash
uv run --with zstandard python tools/extract_rpd.py
uv run --with numpy --with pillow --with scikit-image python tools/build_plan.py
```

`npm run data` runs both in sequence. `tools/build_plan.py` has one option:

```bash
--no-walls    emit plates and stairs only (debug)
```

The main thresholds are constants at the top of `build_plan.py`: `LEVELS`,
`TILE`, `WALL_HEIGHT`, `WALL_MIN_LENGTH`, `FLOOR_MIN_AREA` and
`FOOTPRINT_DILATE_M`.

## 6. Notes and limits

- Stage geometry is stored in world space, so no scene/prefab transforms were
  needed.
- The plan is intentionally an interpretation. Only the three main plate levels
  are used; mezzanines, the 3F clock-tower exterior, railings and all props are
  omitted.
- The 1F footprint is anchored by the 2F/3F room masks and the main hall. Without
  that clip, the outdoor terrain around the RPD dominates the plan.
- Stairs are reconstructed from sloped clusters and their bounding boxes, so
  they indicate direction and rise rather than exact treads.
- The mesh parser handles the RE2 RT variant only. Other RE Engine versions use
  different subdivision/header layouts.
- `data/raw/` is not committed; `public/rpd/rpd.bin` is the derived scene.
