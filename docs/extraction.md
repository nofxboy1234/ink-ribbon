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

This pass replaces the stylized plan with the actual LOD-0 RPD meshes. The
builder is `tools/build_real.py`. There is no simplification, no edge
extraction and no texture data.

### 3.1 Read, clip and filter

All 49 meshes are read at LOD 0. Triangles are kept when every vertex lies in
`[-60, -8, -40] … [55, 55, 30]`; this removes the distant backdrop. Degenerate
triangles and flat up-facing triangles within 1.6 m of each room's maximum Y
(roof/ceiling caps) are dropped. Everything else remains: walls, floors, stairs,
doors, railings, furniture, sloped roofs and the clock tower.

Flat roofs are the exception: because each room's top is defined by its own mesh
bounds, a room that shares a tall space with the tower can keep lower roof
slopes. The result is a real building shell, not a cutaway.

### 3.2 Flat material colours

The mesh header stores a material index per subdivision but no material names or
textures. The builder maps the 35 indices onto twelve muted architectural
colours (limestone, concrete, wood, blue-grey metal, slate, brick, etc.) and
writes one RGB colour per vertex. There are no UVs and the fragment shader does
not sample any material texture.

### 3.3 Chunking and quantization

Source vertices are 2,059,499; many are duplicated across material slices. The
builder hashes position (1 mm grid) plus material colour, producing 1,102,944
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

**Result:** 1,790,053 source triangles → **1,716,488 triangles**, 1,102,944
vertices, 19 chunks, 20.2 MB.

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

`rpd.json` records the method, per-floor bounds, chunk counts, the material
palette and the clip/ceiling filters.

## 5. Reproduce

```bash
uv run --with zstandard python tools/extract_rpd.py
uv run --with numpy python tools/build_real.py
```

`npm run data` runs both in sequence. The main constants are in
`tools/build_real.py`: `CLIP_MIN`/`CLIP_MAX`, `CEILING_CUT`, `MAX_CHUNK_VERTS`
and the material palette.

## 6. Notes and limits

- Stage geometry is stored in world space, so no scene/prefab transforms were
  needed.
- The model is the complete LOD-0 level within the clip box. There is no
  collision, no UV/texture pass and no alpha-cutout material support.
- Materials are identified only by their numeric index, so the colours convey
  surface separation rather than exact real-world material identity.
- The 20.2 MB asset is under Cloudflare's 25 MiB per-asset limit and is served
  as one file. Initial load and wasm upload take a few seconds on a local
  connection.
- The mesh parser handles the RE2 RT variant only. Other RE Engine versions use
  different subdivision/header layouts.
- `data/raw/` is not committed; `public/rpd/rpd.bin` is the derived scene.

## 7. Simplified blockout

`/blockout` uses a separate RPDW v4 asset, `public/rpd/blockout.bin`, built by
`tools/build_blockout.py`.

- Each real room mesh is processed separately: its vertical wall triangles are
  projected into wall bands, and the bands become 1.5 m panel boxes with the
  source door and window gaps.
- Floors are 3 m plates derived from the real room floor masks.
- Stair surfaces come directly from the source stair triangles, so their
  positions and angles are the original ones. Vertical railing/stringer
  triangles are excluded.
- Roofs and ceilings are omitted.
- Output: 26,719 vertices, 31,311 triangles, 38,283 structural edges and 1,028
  floor edges, 1.01 MB.

The blockout renderer draws translucent white fills with distance-based alpha,
bright structural edges and a dimmer floor-edge range.

Build it with:

```bash
npm run blockout
```

## 8. Original-geometry wireframe

`/blockout2` uses the full real `rpd.bin`. At load it builds a line buffer from
triangle edges longer than 0.7 m, classifies horizontal floor edges into the
dim range, and draws the original fill plus white edges. This preserves the
complete original layout and detail; no extra asset is shipped for it.
