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

## 3. Real geometry scene

The scene is built in Blender from the actual LOD-0 RPD meshes. There is no
simplification, no edge extraction and no texture data.

### 3.1 Read all LOD-0 geometry

All 49 meshes are read at LOD 0. Every triangle is kept; there is no clip-box
filter, no degenerate filter and no ceiling/roof trim. The scene contains walls,
floors, stairs, doors, railings, furniture, ceilings, roofs, distant backdrop
triangles and the clock tower. Only the camera framing bounds are restricted to
the RPD area.

### 3.2 The Blender scene

`tools/rpd_scene.py --import` writes `build/rpd.blend`. The scene holds one mesh
object per room, named by room stem, with `rpd_room` and `rpd_floor` custom
properties. Each room has one material per source material. The material name
carries the source name and the colour comes from twelve flat grey shades.
`diffuse_color` is what the export reads, so a colour change in Blender changes
the asset.

The scene is Z up. Import maps source metres (Y up) with `blender = (x, -z, y)`
and bakes that map into the vertex positions, so every object has an identity
transform. Export maps back with `source = (X, Z, -Y)`.

The scene also holds a camera and a sun. The camera uses the same overview
angles as the viewer's reset camera. Export ignores non-mesh objects.

`--import` prints one line per room and asserts that the total is 1,790,053
triangles. It records the count in the `rpd_triangles` scene property.
`--export` asserts that the exported count matches, so a silent truncation
fails.

### 3.3 Chunking and quantization

Source vertices are 2,059,499; many are duplicated across material slices. The
exporter hashes position (1 mm grid) plus material colour, producing 1,116,068
vertices. Triangles are packed into 19 chunks with at most 60k unique vertices
each, so local indices fit in `u16`.

Each chunk stores:

- a float origin and a uniform scale;
- positions as `u16[3]` relative to the origin (`origin + q * scale`);
- colours as `u8[3]`;
- triangle indices as `u16[3]`.

The chunk extent is at most the RPD width, so the position step is under 2 mm.
The renderer expands everything into one float-position/`u8`-colour vertex
buffer plus one `u32` index buffer and draws the whole building in one call.

**Result:** 1,790,053 triangles, 1,116,068 vertices, 19 chunks, 20.8 MB. Only the room terrain is packed.

## 4. `rpd.bin` v3

```
0    char[4]  "RPDW"
4    u32      version = 3
8    u32      chunk_count
12   u32      total_vertex_count
16   u32      total_triangle_count
20   u32      floor_count (3)
24   u32      reserved
28   f32[3]   bounds_min
40   f32[3]   bounds_max
52   floor[3] 16 bytes each:
       u32 chunk_start
       u32 chunk_count
       f32 y_min
       f32 y_max
100  chunk[chunk_count]:
       u32 vertex_count
       u32 index_count        (indices, not triangles)
       u32 floor
       u32 reserved
       f32 origin[3]
       f32 scale
       u16 positions[vertex_count * 3]
       u8  colors[vertex_count * 3]
       u16 indices[index_count]
       pad to 4-byte boundary
```

`rpd.json` records the method, per-floor bounds, chunk counts and the geometry
filter.

## 5. Reproduce

```bash
npm run data
```

That runs three commands.

```bash
uv run --with zstandard python tools/extract_rpd.py
npm run scene:import
npm run scene:export
```

`scene:import` runs `blender -b -P tools/rpd_scene.py -- --import`. `scene:export`
runs `blender -b build/rpd.blend -P tools/rpd_scene.py -- --export`.

To edit the level, run `scene:import`, open `build/rpd.blend` in Blender, make
your changes, then run `scene:export`. `build/` is gitignored, so the scene is
local. The exporter rejects a triangle count that differs from the imported
count. Update the `rpd_triangles` scene property when a geometry change is
intentional.

The constants live in `tools/rpd_scene.py`: `MAX_CHUNK_VERTS`, `QUANT`,
`FRAME_MIN`, `FRAME_MAX` and the material palette.

## 6. Notes and limits

- Stage geometry is stored in world space, so no scene/prefab transforms were
  needed.
- The model contains every LOD-0 triangle from the extracted meshes. There is no
  collision, no UV/texture pass and no alpha-cutout material support.
- Each material keeps its source name, but the flat colours convey surface
  separation rather than exact real-world material identity.
- The 20.8 MB asset is under Cloudflare's 25 MiB per-asset limit and is served
  as one file. Initial load and wasm upload take a few seconds on a local
  connection.
- The mesh parser handles the RE2 RT variant only. Other RE Engine versions use
  different subdivision/header layouts.
- `data/raw/` is not committed; `public/rpd/rpd.bin` is the derived scene.

## Quest layer

The viewer also carries a Claire A, Hardcore quest layer for RPD floors 1-3.
It is generated after the Blender import and does not change `rpd.bin`.

1. `tools/rpd_grid.py` opens `build/rpd.blend`, casts rays down each 1 m cell
   at the 1F split levels (0.0 and 0.8 m), 2F (5.2 m) and 3F (10.4 m), and
   keeps flat cells with 1.7 m of headroom and 0.46 m of shoulder clearance.
   The result is `public/rpd/grid.json`, used only to place items.
2. `tools/rpd_quest.py` reads `tools/rpd_ap_source.json`, which holds the
   Claire A RPD regions, vanilla item locations, Hardcore ink-ribbon overrides
   and region connections from the
   [RE2R Archipelago world](https://github.com/FuzzyGamesOn/RE2R_AP_World).
   It assigns every item to a walkable cell near its room, turns the region
   connections into a room graph, places the 25 modelled doors at their RPD
   openings, and writes `public/rpd/quest.json`.
3. `tools/rpd_nav.py` opens the same blend and sweeps every 1 m column for
   floor, stair and ramp surfaces at their real heights. It keeps nodes with
   1.75 m headroom and 0.30 m shoulder clearance, links nearby nodes within
   1.45 m using a line-of-sight test, and bridges door and stair gaps. The result is
   `public/rpd/nav.json`.
4. The web app loads `quest.json` and `nav.json`, sends the item and door
   markers to the sokol renderer, and keeps the discovery, inventory, lock and
   route state in React. Paths are A* over the nav graph; locked doors block
   their edges instead of relying on a room-level cost graph.

The RPD scene covers floors 1-3 only. B1 items such as the morgue, firing range
and parking garage are outside the modelled scene and are excluded. Key-to-door
links come from the connection conditions. Container links (lockers, the
weapons locker, the maiden statue and the secured collection area) come from the
location conditions.

## Item models

The map draws the pickup items from the game meshes, not only from the 2D icon
atlas. The source list is `tools/item_model_sources.json`: one entry per model
with a stable id, the MapGenie title and category, the PAK mesh path, and an
optional material override. The item titles come from
`public/rpd/items_mapgenie.json`; a title with no model is recorded as
`unmapped` instead of silently disappearing.

The mesh paths came from the local reze checkout at
`~/repos/reze/tools/RE2_RT_STM_Release.list`. That file is a build input on this
machine, not a runtime dependency. Item meshes live under
`natives/stm/objectroot/setmodel/sm7x_item/`; weapon meshes live under
`natives/stm/sectionroot/character/weapon/`.

### Mesh and material findings

- Item meshes are the same `.mesh.2109108288` variant as the level: internal
  version `21041600`, usually one LOD for the pickup meshes. Weapons carry eight
  LODs, and LOD 0 is about 6k vertices per gun.
- The vertex elements used here are typing `0` (float32 x3 position), typing `1`
  (four int16 values, xyz divided by 32767), and typing `2` (two IEEE half
  floats). Tangents and vertex colours are present on some meshes and are not
  packed.
- A mesh header u16 table at `0x60` remaps each submesh `material` slot to its
  MDF2 material index. The RPD importer applies the same table. The mesh group
  vertex base is the smallest submesh `vertex_start`; face indices stay local to
  the subdivision.
- MDF2 stores UTF-16LE strings. The material count is the u16 at offset `0x06`.
  Albedo comes from `BaseMetalMap`, or `RefractSphereMap` for the shared jewelry
  master material. Normal roughness comes from `NormalRoughnessMap`, or
  `InnerNormalMap` for jewelry.
- A texture reference such as `ObjectRoot/SetModel/textures/foo_ALBM.tex`
  resolves to `natives/stm/objectroot/setmodel/textures/foo_albm.tex.34`, with
  `natives/stm/streaming/` as the fallback root.
- Item albedo textures carry a constant alpha channel, so `tex.decode(...,
  opaque=True)` is correct. All textures are downscaled to 192 px on the long
  edge. The source paths and dimensions stay in the manifest.
- The shared `Env_Jewelry` material is tinted by a `JewelryColor` parameter.
  This pack does not evaluate material parameters. The red jewel records a flat
  tint; the jewelry box stays neutral metal.

### `ITM1` binary

| Offset | Type | Meaning |
|---:|---|---|
| 0 | char[4] | `ITM1` |
| 4 | u32 | version, currently 1 |
| 8 | u32 | model count |
| 12 | u32 | material count |
| 16 | u32 | directory offset |
| 20 | u32 | material table offset |
| 24 | u32 | string table offset |
| 28 | u32 | string table size |

Each directory entry is 108 bytes:

```
char id[24]
u32 vertex_offset, vertex_count
u32 index_offset, index_count
u32 primitive_offset
u32 primitive_count
u16 index_size, lod
f32 origin[3], quant_scale
f32 bounds_min[3], bounds_max[3]
f32 metres_per_unit
f32 pivot_source[3]
```

Vertices are 20 bytes: `u16 position[3]`, `i16 normal[4]`, `u16 uv[2]`, `u16
pad`. Decode a position with `origin + position * quant_scale`. UVs are stored
with a top-left V origin; the Blender verifier flips V for Blender's bottom-left
images. Each primitive is 16 bytes: `u32 index_start, index_count, material,
flags`. Each material is
32 bytes: `u32 albedo_name_offset, albedo_source_offset, normal_source_offset,
flags; f32 base_color[4]`. String offsets are byte offsets into the string table;
zero means no string.

Geometry is normalised so its largest bounding axis is 1.0, with the pivot at
the source bounds centre on X/Z and the minimum Y. `metres_per_unit` recovers the
source size: `source = normalised * metres_per_unit + pivot_source`. The source
up axis is Y, and the yaw is the source mesh yaw; no billboard rotation is
applied.

### Build and verify

```bash
npm run item-models
npm run item-models:check
```

`item-models` writes `public/rpd/item_models.bin`, the manifest
`public/rpd/item_models.json`, and the decoded albedos under
`public/rpd/item_models/`. Retail dumps go to `data/raw/item_models/`, which is
gitignored.

`item-models:check` runs the Blender verifier. It checks the header, every
offset and index bound, primitive material ranges, the decoded bounds, and the
normalised pivot, then renders one image per model. The labelled sheets are
`verification/item_models/contact-*.png`; the per-model images and
`report.json` are local.

The current asset holds 72 models, 74 materials and 72 textures: 149,762
vertices and 181,018 triangles in a 4.11 MB pack. 88 of the 134 distinct
MapGenie titles resolve to a model. The other 46 are transitions, doors,
windows, locks, puzzles and room fixtures, not pickup items.
