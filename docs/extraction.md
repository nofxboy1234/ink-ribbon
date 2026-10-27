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

## 3. Cutaway and scene construction

`tools/build_scene.py` processes the 49 meshes in floor order:

1. **LOD 0 only.** Every RPD room has one LOD group.
2. **Weld nothing; keep room-local vertices.** Rooms are separate draws in the
   source and their shared walls are duplicated, which is harmless for an edge
   renderer.
3. **Drop downward-facing triangles** (`cross(b-a, c-a).y < 0`). This removes
   floors' undersides and a large fraction of redundant double-sided surfaces.
4. **Drop the room's top envelope.** Horizontal triangles (Y span < 0.35 m)
   whose centroid is within 1.6 m of the room's maximum Y are ceilings or roofs.
   Removing them turns each room into an open-topped cutaway.
5. **Clip.** Triangles with any vertex outside
   `[-60, -8, -40] … [55, 55, 30]` are backdrop geometry (distant walls, roof
   tails, skyline pieces) and are dropped. This removes 81 triangles and the
   long spikes visible in an unfiltered render.
6. **Simplify** each room with `fast_simplification.simplify(..., agg=7)` at a
   target reduction of 0.88. The source is heavily tessellated; the map only
   needs the silhouette and architectural features.
7. **Extract unique edges.** For each room, edges are keyed by their vertex
   pair. An edge is kept when it is a boundary edge, at least 0.3 m long, the
   adjacent face normals differ by at least 22°, or (via `--edge-long`, default
   2.2 m) it is long enough to form a coarse floor grid. This keeps door frames,
   wall/floor junctions and structural lines without drawing every sub-pixel
   triangle edge.
8. **Pack** positions, triangle indices and line indices into `rpd.bin`.

Current result: 1,790,053 source triangles → 111,596 triangles, 147,078
vertices, 29,437 edges, 3.3 MB.

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

`rpd.json` records the same counts, source room names, per-floor ranges, and the
filter statistics for inspection.

## 5. Reproduce

```bash
uv run --with zstandard python tools/extract_rpd.py
uv run --with numpy --with fast-simplification python tools/build_scene.py
```

Useful flags:

```bash
--keep-ceilings        keep the top-envelope cut (debug)
--no-dedupe            keep exact duplicate triangles
--reduction 0          skip simplification
--edge-min 0.3         minimum edge length in metres
--edge-angle 22        crease angle for feature edges
--edge-long 2.2        keep coplanar edges at least this long (0 disables)
```

## 6. Notes and limits

- Stage geometry is stored in world space, so no scene/prefab transforms were
  needed. The floor offsets in `rpd.json` are Y ranges from the mesh data.
- Room `st4_602_0` is the 3F clock tower. Its base sits in the open atrium, so it
  can read as detached from some camera angles.
- The mesh parser handles the RE2 RT variant only. Other RE Engine versions use
  different subdivision/header layouts.
- `data/raw/` is not committed; `public/rpd/rpd.bin` is the derived scene.
