#!/usr/bin/env python3
"""Extract the RE2 item meshes and pack them for the sokol map.

The input is ``tools/item_model_sources.json``. Each model names a PAK mesh and,
optionally, its MDF2 material. The tool resolves the material's albedo and
normal textures, decodes the game texture, normalises the geometry to a one unit
bounding box with its pivot at the base centre, and writes:

- ``public/rpd/item_models.bin``  packed geometry, self describing
- ``public/rpd/item_models.json`` model, material and MapGenie item manifest
- ``public/rpd/item_models/*.png`` decoded albedo textures

Retail mesh, material and texture dumps stay in ``data/raw/item_models``.

Run:
    uv run --with zstandard --with texture2ddecoder --with pillow \
        python tools/extract_item_models.py
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import pathlib
import re
import struct
import sys

from PIL import Image

import re_pak
import remesh
import tex

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCES = ROOT / "tools" / "item_model_sources.json"
RAW = ROOT / "data" / "raw" / "item_models"
OUT = ROOT / "public" / "rpd"
MODELS = OUT / "item_models"
MAPGENIE = OUT / "items_mapgenie.json"
BIN = OUT / "item_models.bin"
MANIFEST = OUT / "item_models.json"

MAGIC = b"ITM1"
VERSION = 1
HEADER = struct.Struct("<4sIIIIIII")
DIRECTORY = struct.Struct("<24sIIIIIIHH3ff3f3ff3f")
PRIMITIVE = struct.Struct("<IIII")
MATERIAL = struct.Struct("<IIII4f")
VERTEX_STRIDE = 20
MAP_KEYS = {
    "BaseMetalMap",
    "NormalRoughnessMap",
    "AlphaTranslucentOcclusionSSSMap",
    "RefractSphereMap",
    "InnerNormalMap",
    "BaseColor",
    "Metallic",
    "Roughness",
    "Translucency",
    "AlphaTestRef",
    "JewelryColor",
    "Brightness",
    "FlashIntensity",
    "FlashTime",
    "FlashNum",
    "RainRipples_AreaMap",
    "RainRipples_Map",
    "RainWet_down_Map",
    "RainWet_drop_Map",
    "RainFall_Map",
    "FakeSphereMap",
}
ALBEDO_KEYS = ("BaseMetalMap", "RefractSphereMap")
NORMAL_KEYS = ("NormalRoughnessMap", "InnerNormalMap")


@dataclasses.dataclass(frozen=True)
class Material:
    name: str
    master: str
    albedo_ref: str | None
    normal_ref: str | None
    base_color: tuple[float, float, float, float]


@dataclasses.dataclass
class Geometry:
    positions: list[tuple[float, float, float]]
    normals: list[tuple[int, int, int, int]]
    uvs: list[tuple[int, int]]
    indices: list[int]
    primitives: list[dict]
    index_size: int


_ENTRY_CACHE: dict[str, re_pak.PakEntry | None] = {}


def find(paths: list[str]) -> dict[str, re_pak.PakEntry]:
    """Look up the paths that exist without failing the run for optional assets."""
    pending = [path for path in paths if path not in _ENTRY_CACHE]
    if pending:
        wanted = {re_pak.path_hash(path): path for path in pending}
        for name in re_pak.ARCHIVES:
            archive = re_pak.GAME_DIR / name
            if not archive.is_file():
                continue
            for entry in re_pak._entries(archive, wanted):
                _ENTRY_CACHE[entry.path] = entry
        for path in pending:
            _ENTRY_CACHE.setdefault(path, None)
    return {path: _ENTRY_CACHE[path] for path in paths if _ENTRY_CACHE[path] is not None}


def utf16_strings(data: bytes) -> list[tuple[int, str]]:
    return [
        (match.start(), match.group().decode("utf-16-le"))
        for match in re.finditer(rb"(?:[\x20-\x7e]\x00){2,}", data)
    ]


def material_groups(data: bytes) -> list[list[tuple[str, str]]]:
    count = struct.unpack_from("<H", data, 6)[0]
    strings = utf16_strings(data)
    maps: list[tuple[str, str]] = []
    for index, (_, text) in enumerate(strings):
        if text in MAP_KEYS and index + 1 < len(strings):
            value = strings[index + 1][1]
            if value.endswith(".tex"):
                maps.append((text, value))
    groups: list[list[tuple[str, str]]] = []
    for key, value in maps:
        if groups and key in ("BaseMetalMap", "InnerNormalMap"):
            has_albedo = any(item[0] in ALBEDO_KEYS for item in groups[-1])
            if has_albedo:
                groups.append([])
        if not groups:
            groups.append([])
        groups[-1].append((key, value))
    if len(groups) != count:
        raise ValueError(f"material count {count} does not match {len(groups)} map blocks")
    return groups


def parse_material(data: bytes) -> list[Material]:
    count = struct.unpack_from("<H", data, 6)[0]
    strings = utf16_strings(data)
    names = [text for _, text in strings if not text.endswith(".tex") and "/" not in text][:count]
    masters = [text for _, text in strings if text.endswith(".mmtr")]
    groups = material_groups(data)
    materials: list[Material] = []
    for index, group in enumerate(groups):
        albedo = next((value for key, value in group if key in ALBEDO_KEYS), None)
        normal = next((value for key, value in group if key in NORMAL_KEYS), None)
        materials.append(
            Material(
                name=names[index] if index < len(names) else f"material_{index}",
                master=masters[index] if index < len(masters) else "",
                albedo_ref=albedo,
                normal_ref=normal,
                base_color=(1.0, 1.0, 1.0, 1.0),
            )
        )
    return materials


def material_candidates(mesh_path: str, explicit: str | None) -> list[str]:
    if explicit:
        return [explicit]
    stem = mesh_path.removesuffix(".mesh.2109108288")
    return [stem + "_mat.mdf2.21", stem + ".mdf2.21"]


def texture_candidates(ref: str) -> list[str]:
    if not ref or ref.startswith("systems/") or ref.startswith("RE_ENGINE_LIBRARY/"):
        return []
    clean = ref.removesuffix(".tex")
    return [
        "natives/stm/" + clean.lower() + ".tex.34",
        "natives/stm/streaming/" + clean.lower() + ".tex.34",
    ]


def material_remap(data: bytes) -> tuple[int, ...]:
    """Map a mesh material slot to its MDF2 material index.

    The mesh header carries a u16 table at 0x60. The RPD importer applies the
    same table before naming materials, and the item meshes use it too.
    """
    mesh_offset = struct.unpack_from("<Q", data, 0x18)[0]
    count = data[mesh_offset + 1]
    remap_offset = struct.unpack_from("<Q", data, 0x60)[0]
    if not remap_offset or not count:
        return tuple(range(count))
    values = struct.unpack_from(f"<{count}H", data, remap_offset)
    if any(value >= count for value in values):
        return tuple(range(count))
    return values


def geometry(mesh_bytes: bytes, lod: int) -> Geometry:
    mesh = remesh.parse(mesh_bytes)
    remap = material_remap(mesh_bytes)
    if lod >= len(mesh.lods):
        raise ValueError(f"LOD {lod} outside 0..{len(mesh.lods) - 1}")
    group = mesh.lods[lod]
    position = next(e for e in mesh.vertex_elements if e.typing == 0)
    normal = next((e for e in mesh.vertex_elements if e.typing == 1), None)
    uv = next((e for e in mesh.vertex_elements if e.typing == 2), None)
    positions: list[tuple[float, float, float]] = []
    normals: list[tuple[int, int, int, int]] = []
    uvs: list[tuple[int, int]] = []
    indices: list[int] = []
    primitives: list[dict] = []
    index_size = 4 if mesh.has_32bit_indices else 2
    index_fmt = "<I" if index_size == 4 else "<H"
    for part in group.groups:
        base = remesh.group_vertex_base(part)
        vertex_base = len(positions)
        for i in range(part.vertex_count):
            source = base + i
            offset = position.start + source * position.stride
            positions.append(struct.unpack_from("<3f", mesh.vertex_buffer, offset))
            if normal is not None:
                offset = normal.start + source * normal.stride
                normals.append(struct.unpack_from("<4h", mesh.vertex_buffer, offset))
            else:
                normals.append((0, 32767, 0, 0))
            if uv is not None:
                offset = uv.start + source * uv.stride
                uvs.append(struct.unpack_from("<2H", mesh.vertex_buffer, offset))
            else:
                uvs.append((0, 0))
        for sub in part.submeshes:
            if sub.index_count == 0:
                continue
            local = sub.vertex_start - base
            start = len(indices)
            for i in range(sub.index_count):
                offset = (sub.index_start + i) * index_size
                value = struct.unpack_from(index_fmt, mesh.index_buffer, offset)[0]
                indices.append(value + local + vertex_base)
            primitives.append(
                {
                    "index_start": start,
                    "index_count": sub.index_count,
                    "material": remap[sub.material] if sub.material < len(remap) else sub.material,
                }
            )
    if not positions or not indices:
        raise ValueError("mesh has no drawable geometry")
    if max(indices) > 0xFFFF:
        index_size = 4
    return Geometry(positions, normals, uvs, indices, primitives, index_size)


def normalise(positions: list[tuple[float, float, float]], target: float):
    xs = [p[0] for p in positions]
    ys = [p[1] for p in positions]
    zs = [p[2] for p in positions]
    source_min = (min(xs), min(ys), min(zs))
    source_max = (max(xs), max(ys), max(zs))
    size = tuple(source_max[i] - source_min[i] for i in range(3))
    extent = max(size)
    if extent <= 1e-9:
        raise ValueError("mesh has no extent")
    pivot = (
        (source_min[0] + source_max[0]) * 0.5,
        source_min[1],
        (source_min[2] + source_max[2]) * 0.5,
    )
    scale = target / extent
    moved = [
        (
            (p[0] - pivot[0]) * scale,
            (p[1] - pivot[1]) * scale,
            (p[2] - pivot[2]) * scale,
        )
        for p in positions
    ]
    normalized_min = tuple(min(p[i] for p in moved) for i in range(3))
    normalized_max = tuple(max(p[i] for p in moved) for i in range(3))
    span = max(normalized_max[i] - normalized_min[i] for i in range(3))
    quant_scale = span / 65535.0
    quantized = [
        tuple(
            max(0, min(65535, round((p[i] - normalized_min[i]) / quant_scale)))
            for i in range(3)
        )
        for p in moved
    ]
    bounds_min = tuple(normalized_min[i] for i in range(3))
    bounds_max = tuple(
        normalized_min[i]
        + quant_scale * max(q[i] for q in quantized)
        for i in range(3)
    )
    return {
        "quantized": quantized,
        "origin": normalized_min,
        "quant_scale": quant_scale,
        "bounds_min": bounds_min,
        "bounds_max": bounds_max,
        "source_min": source_min,
        "source_max": source_max,
        "source_pivot": pivot,
        "source_extent": extent,
        "metres_per_unit": extent / target,
    }


def decode_texture(path: str, size: int):
    entry = find([path])[path]
    data = re_pak.read(entry)
    image = tex.decode(data, opaque=True)
    picture = Image.frombytes("RGBA", (image.width, image.height), image.rgba).convert("RGB")
    source_size = [image.width, image.height]
    picture.thumbnail((size, size), Image.Resampling.LANCZOS)
    return data, picture, source_size


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=pathlib.Path, default=SOURCES)
    parser.add_argument("--texture-size", type=int, default=0)
    parser.add_argument("--no-raw", action="store_true")
    args = parser.parse_args()

    config = json.loads(args.sources.read_text(encoding="utf-8"))
    target = float(config.get("target_size", 1.0))
    texture_size = args.texture_size or int(config.get("texture_size", 256))
    sources = config["models"]

    if not re_pak.GAME_DIR.is_dir():
        sys.exit(f"RE2 install not found: {re_pak.GAME_DIR}\nset RE2_GAME_DIR")

    ids = [source["id"] for source in sources]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate model ids in the sources file")
    for model_id in ids:
        if len(model_id) > 24:
            raise ValueError(f"model id longer than 24 bytes: {model_id}")

    mesh_paths = [source["mesh"] for source in sources]
    candidates = [material_candidates(source["mesh"], source.get("material")) for source in sources]
    entries = find(mesh_paths + [path for group in candidates for path in group])
    missing = [path for path in mesh_paths if path not in entries]
    if missing:
        sys.exit("missing PAK entries:\n  " + "\n  ".join(sorted(set(missing))))

    material_paths = []
    for source, group in zip(sources, candidates):
        path = next((candidate for candidate in group if candidate in entries), None)
        if path is None:
            sys.exit(f"no material file for {source['id']}: {group}")
        material_paths.append(path)

    mesh_data_by_id = {}
    material_data_by_id = {}
    texture_refs: list[list[str]] = []
    for source, mesh_path, material_path_value in zip(sources, mesh_paths, material_paths):
        mesh_data_by_id[source["id"]] = re_pak.read(entries[mesh_path])
        material_data = re_pak.read(entries[material_path_value])
        material_data_by_id[source["id"]] = material_data
        mesh_materials = parse_material(material_data)
        texture_refs.append(
            [
                ref
                for material in mesh_materials
                for ref in (material.albedo_ref, material.normal_ref)
                if ref
            ]
        )

    texture_entries = find(
        [path for refs in texture_refs for ref in refs for path in texture_candidates(ref)]
    )
    resolved_textures: dict[str, str | None] = {}
    for refs in texture_refs:
        for ref in refs:
            if ref in resolved_textures:
                continue
            resolved_textures[ref] = next(
                (path for path in texture_candidates(ref) if path in texture_entries), None
            )
    missing_textures = sorted(
        {ref for refs in texture_refs for ref in refs if resolved_textures[ref] is None}
    )

    RAW.mkdir(parents=True, exist_ok=True)
    MODELS.mkdir(parents=True, exist_ok=True)
    for stale in MODELS.glob("*.png"):
        stale.unlink()

    records: list[dict] = []
    material_pool: dict[tuple, dict] = {}
    material_ids: dict[tuple, int] = {}
    texture_bytes: dict[str, tuple[bytes, Image.Image, list[int]]] = {}
    problems: list[str] = [
        f"missing texture: {ref}"
        for ref in missing_textures
        if texture_candidates(ref)
    ]

    for source, mesh_path, material_path_value in zip(sources, mesh_paths, material_paths):
        mesh_data = mesh_data_by_id[source["id"]]
        material_data = material_data_by_id[source["id"]]
        if not args.no_raw:
            (RAW / pathlib.Path(mesh_path).name).write_bytes(mesh_data)
            (RAW / pathlib.Path(material_path_value).name).write_bytes(material_data)

        mesh_materials = parse_material(material_data)
        geometry_result = geometry(mesh_data, int(source.get("lod", 0)))
        highest_material = max(
            (primitive["material"] for primitive in geometry_result.primitives), default=0
        )
        if highest_material >= len(mesh_materials):
            problems.append(
                f"{source['id']}: material {highest_material} outside the {len(mesh_materials)} entry MDF2 table"
            )
        layout = normalise(geometry_result.positions, target)
        model_materials: list[int] = []
        for index, material in enumerate(mesh_materials):
            albedo_path = resolved_textures.get(material.albedo_ref) if material.albedo_ref else None
            normal_path = resolved_textures.get(material.normal_ref) if material.normal_ref else None
            override = (
                source.get("base_color", [1.0, 1.0, 1.0, 1.0])
                if index == 0
                else [1.0, 1.0, 1.0, 1.0]
            )
            key = (albedo_path or f"solid:{source['id']}:{index}", tuple(round(v, 5) for v in override))
            if key not in material_ids:
                albedo_name = None
                albedo_size = None
                if albedo_path:
                    data, picture, albedo_size = decode_texture(albedo_path, texture_size)
                    albedo_name = (
                        "item_models/"
                        + pathlib.Path(albedo_path).name.removesuffix(".tex.34")
                        + ".png"
                    )
                    picture.save(MODELS / pathlib.Path(albedo_name).name)
                    texture_bytes[albedo_path] = (data, picture, albedo_size)
                    if not args.no_raw:
                        (RAW / pathlib.Path(albedo_path).name).write_bytes(data)
                material_ids[key] = len(material_pool)
                material_pool[key] = {
                    "albedo": albedo_name,
                    "albedo_size": albedo_size,
                    "albedo_source": albedo_path,
                    "normal_source": normal_path,
                    "base_color": [round(value, 5) for value in override],
                }
            model_materials.append(material_ids[key])

        for primitive in geometry_result.primitives:
            if primitive["material"] >= len(mesh_materials):
                primitive["material"] = 0
        records.append(
            {
                "id": source["id"],
                "source": source,
                "material_path": material_path_value,
                "geometry": geometry_result,
                "layout": layout,
                "materials": model_materials,
            }
        )

    material_list = list(material_pool.values())

    strings: list[str] = []
    string_offsets: dict[str, int] = {}
    string_size = 1

    def intern(text: str | None) -> int:
        nonlocal string_size
        if not text:
            return 0
        if text not in string_offsets:
            string_offsets[text] = string_size
            encoded = text.encode() + b"\0"
            strings.append(text)
            string_size += len(encoded)
        return string_offsets[text]

    material_records = []
    for record in material_list:
        material_records.append(
            {
                **record,
                "albedo_name_offset": intern(record["albedo"]),
                "albedo_source_offset": intern(record["albedo_source"]),
                "normal_source_offset": intern(record["normal_source"]),
            }
        )
    string_table = b"\0" + b"".join(text.encode() + b"\0" for text in strings)

    directory_offset = HEADER.size
    primitive_offset = directory_offset + DIRECTORY.size * len(records)
    primitive_count = sum(len(record["geometry"].primitives) for record in records)
    material_offset = primitive_offset + PRIMITIVE.size * primitive_count
    string_offset = material_offset + MATERIAL.size * len(material_records)
    blob_offset = (string_offset + len(string_table) + 3) & ~3

    blobs = bytearray()
    cursor = blob_offset
    primitive_cursor = primitive_offset
    for record in records:
        layout = record["layout"]
        geometry_result = record["geometry"]
        vertex_bytes = bytearray()
        for position, normal, uv in zip(
            layout["quantized"], geometry_result.normals, geometry_result.uvs
        ):
            vertex_bytes += struct.pack("<3H4h2H2x", *position, *normal, *uv)
        index_format = "<I" if geometry_result.index_size == 4 else "<H"
        index_bytes = b"".join(
            struct.pack(index_format, index) for index in geometry_result.indices
        )
        record["vertex_offset"] = cursor
        record["vertex_count"] = len(layout["quantized"])
        record["index_offset"] = cursor + len(vertex_bytes)
        record["index_count"] = len(geometry_result.indices)
        record["primitive_offset"] = primitive_cursor
        primitive_cursor += PRIMITIVE.size * len(geometry_result.primitives)
        blobs += vertex_bytes
        blobs += index_bytes
        cursor += len(vertex_bytes) + len(index_bytes)
        while cursor % 4:
            blobs += b"\0"
            cursor += 1

    with BIN.open("wb") as file:
        file.write(
            HEADER.pack(
                MAGIC,
                VERSION,
                len(records),
                len(material_records),
                directory_offset,
                material_offset,
                string_offset,
                len(string_table),
            )
        )
        for record in records:
            layout = record["layout"]
            file.write(
                DIRECTORY.pack(
                    record["id"].encode().ljust(24, b"\0"),
                    record["vertex_offset"],
                    record["vertex_count"],
                    record["index_offset"],
                    record["index_count"],
                    record["primitive_offset"],
                    len(record["geometry"].primitives),
                    record["geometry"].index_size,
                    int(record["source"].get("lod", 0)),
                    *layout["origin"],
                    layout["quant_scale"],
                    *layout["bounds_min"],
                    *layout["bounds_max"],
                    layout["metres_per_unit"],
                    *layout["source_pivot"],
                )
            )
        for record in records:
            for primitive in record["geometry"].primitives:
                file.write(
                    PRIMITIVE.pack(
                        primitive["index_start"],
                        primitive["index_count"],
                        record["materials"][primitive["material"]],
                        0,
                    )
                )
        for record in material_records:
            file.write(
                MATERIAL.pack(
                    record["albedo_name_offset"],
                    record["albedo_source_offset"],
                    record["normal_source_offset"],
                    0,
                    *record["base_color"],
                )
            )
        file.write(string_table)
        while file.tell() % 4:
            file.write(b"\0")
        file.write(blobs)

    manifest_models = {}
    for record in records:
        source = record["source"]
        layout = record["layout"]
        geometry_result = record["geometry"]
        manifest_models[record["id"]] = {
            "title": source["title"],
            "category": source["category"],
            "status": source["status"],
            "note": source.get("note"),
            "source": {
                "mesh": source["mesh"],
                "material": record["material_path"],
                "lod": int(source.get("lod", 0)),
            },
            "materials": record["materials"],
            "geometry": {
                "vertex_offset": record["vertex_offset"],
                "vertex_count": record["vertex_count"],
                "index_offset": record["index_offset"],
                "index_count": record["index_count"],
                "index_size": geometry_result.index_size,
                "primitive_offset": record["primitive_offset"],
                "primitives": geometry_result.primitives,
            },
            "bounds": {
                "normalised": {
                    "min": [round(value, 6) for value in layout["bounds_min"]],
                    "max": [round(value, 6) for value in layout["bounds_max"]],
                },
                "source": {
                    "min": [round(value, 6) for value in layout["source_min"]],
                    "max": [round(value, 6) for value in layout["source_max"]],
                },
            },
            "pivot_source": [round(value, 6) for value in layout["source_pivot"]],
            "metres_per_unit": round(layout["metres_per_unit"], 6),
            "triangles": len(geometry_result.indices) // 3,
        }

    mapgenie = json.loads(MAPGENIE.read_text(encoding="utf-8"))
    titles: dict[str, dict] = {}
    for item in mapgenie["items"]:
        titles.setdefault(item["title"], item["category"])
    explicit = config.get("items", {})
    category_models = config.get("category_models", {})
    items = {}
    for title, category in sorted(titles.items()):
        model_id = explicit.get(title) or category_models.get(category)
        if model_id is None:
            items[title] = {"category": category, "model": None, "status": "unmapped"}
        elif model_id not in manifest_models:
            raise KeyError(f"item {title} points at unknown model {model_id}")
        else:
            items[title] = {
                "category": category,
                "model": model_id,
                "status": manifest_models[model_id]["status"],
            }

    materials_manifest = []
    for record in material_records:
        materials_manifest.append(
            {
                "albedo": record["albedo"],
                "albedo_size": record["albedo_size"],
                "albedo_source": record["albedo_source"],
                "normal_source": record["normal_source"],
                "base_color": record["base_color"],
            }
        )

    total_vertices = sum(record["vertex_count"] for record in records)
    total_triangles = sum(len(record["geometry"].indices) // 3 for record in records)
    mapped = sum(1 for item in items.values() if item["model"])
    manifest = {
        "version": VERSION,
        "asset": BIN.name,
        "texture_dir": "item_models",
        "texture_size": texture_size,
        "units": {
            "source": "metre",
            "source_up_axis": "y",
            "normalised": "largest bounding axis is 1.0",
            "orientation": "source mesh yaw, Y up; no billboard or facing applied",
            "pivot": "source bounds centre on x and z, minimum y",
            "metres_per_unit": "multiply by a model's metres_per_unit to recover source metres",
            "restore_source": "p * metres_per_unit + pivot_source",
        },
        "layout": {
            "vertex_stride": VERTEX_STRIDE,
            "position": "u16 x3, decoded with bounds.origin and quant_scale",
            "normal": "i16 x4, xyz divided by 32767",
            "uv": "u16 x2, IEEE half floats, V origin top-left",
            "alpha": "albedo alpha is constant; textures are decoded opaque",
            "index": "u16 unless index_size is 4",
        },
        "stats": {
            "models": len(records),
            "materials": len(material_records),
            "textures": len(texture_bytes),
            "items": len(items),
            "items_mapped": mapped,
            "vertices": total_vertices,
            "triangles": total_triangles,
            "bytes": BIN.stat().st_size,
        },
        "models": manifest_models,
        "materials": materials_manifest,
        "items": items,
        "problems": problems,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(
        f"packed {len(records)} models, {len(material_records)} materials, "
        f"{len(texture_bytes)} textures"
    )
    print(
        f"{total_vertices:,} vertices, {total_triangles:,} triangles, "
        f"{BIN.stat().st_size / 1e6:.2f} MB -> {BIN.relative_to(ROOT)}"
    )
    print(f"{mapped}/{len(items)} MapGenie item titles mapped")
    if problems:
        print("problems:")
        for problem in problems:
            print("  " + problem)


if __name__ == "__main__":
    main()
