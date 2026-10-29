#!/usr/bin/env python3
"""Round-trip the decompiled RPD between Blender and the viewer asset.

``--import`` reads ``data/raw/rpd/*.mesh`` into one object per room, one
material per source material, and saves ``build/rpd.blend``. Edit that scene,
then ``--export`` packs it into ``public/rpd/rpd.bin`` and
``public/rpd/rpd.json`` for the page at ``/``.
"""
from __future__ import annotations

import argparse
import array
import json
import math
import pathlib
import struct
import sys

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import remesh

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "rpd"
BLEND = ROOT / "build" / "rpd.blend"
OUT_BIN = ROOT / "public" / "rpd" / "rpd.bin"
OUT_JSON = ROOT / "public" / "rpd" / "rpd.json"

FLOOR_OF_ROOM = {"1": 0, "2": 0, "3": 0, "4": 1, "5": 1, "6": 2}
FLOOR_BANDS = ((4.4, 0), (9.4, 1))
FRAME_MIN = np.array([-60.0, -8.0, -40.0])
FRAME_MAX = np.array([55.0, 55.0, 30.0])
EXPECTED_TRIANGLES = 1_790_053
MAX_CHUNK_VERTS = 60000
VERSION = 3
QUANT = 1000.0


def material_colour(index: int):
    palette = (
        (0.66, 0.66, 0.66),
        (0.48, 0.48, 0.48),
        (0.58, 0.58, 0.58),
        (0.39, 0.39, 0.39),
        (0.72, 0.72, 0.72),
        (0.30, 0.30, 0.30),
        (0.54, 0.54, 0.54),
        (0.45, 0.45, 0.45),
        (0.62, 0.62, 0.62),
        (0.35, 0.35, 0.35),
        (0.78, 0.78, 0.78),
        (0.42, 0.42, 0.42),
    )
    r, g, b = palette[index % len(palette)]
    lift = 0.025 * (index // len(palette))
    return (
        min(255, int((r + lift) * 255)),
        min(255, int((g + lift) * 255)),
        min(255, int((b + lift) * 255)),
    )


def material_names(data: bytes) -> list[str]:
    count = struct.unpack_from("<h", data, 0x12)[0]
    table = struct.unpack_from("<Q", data, 0x78)[0]
    offsets = struct.unpack_from(f"<{count}Q", data, table)
    return [data[o : data.index(b"\0", o)].decode("ascii", "ignore") for o in offsets]


def material_map(data: bytes) -> list[str]:
    mesh_offset = struct.unpack_from("<Q", data, 0x18)[0]
    count = data[mesh_offset + 1]
    remap_offset = struct.unpack_from("<Q", data, 0x60)[0]
    if remap_offset == 0:
        return material_names(data)
    remap = struct.unpack_from(f"<{count}H", data, remap_offset)
    names = material_names(data)
    return [names[i] if i < len(names) else f"material_{i}" for i in remap]


def room_floor(room: str) -> int:
    return FLOOR_OF_ROOM[room.split("_")[1][0]]


def floor_from_height(y: float) -> int:
    for limit, floor in FLOOR_BANDS:
        if y < limit:
            return floor
    return 2


def to_blender(co):
    """Source metres, Y up, to Blender metres, Z up."""
    co = np.asarray(co, dtype=np.float64)
    return co[..., (0, 2, 1)] * (1.0, -1.0, 1.0)


def from_blender(co):
    """Blender metres, Z up, to source metres, Y up."""
    co = np.asarray(co, dtype=np.float64)
    return co[..., (0, 2, 1)] * (1.0, 1.0, -1.0)


def read_room(path: pathlib.Path):
    data = path.read_bytes()
    mesh = remesh.parse(data)
    index_size = 4 if mesh.has_32bit_indices else 2
    dtype = np.uint32 if index_size == 4 else np.uint16
    corners = []
    face_material = []
    for group in mesh.lods[0].groups:
        pos = np.asarray(remesh.positions(mesh, group), dtype=np.float64)
        base = remesh.group_vertex_base(group)
        for sub in group.submeshes:
            if sub.is_quad or sub.index_count == 0:
                continue
            index = np.frombuffer(
                mesh.index_buffer,
                dtype=dtype,
                count=sub.index_count,
                offset=sub.index_start * index_size,
            ).reshape(-1, 3)
            index = index.astype(np.int64) + (sub.vertex_start - base)
            corners.append(to_blender(pos[index]))
            face_material.append(np.full(len(index), sub.material, dtype=np.int64))
    corners = np.concatenate(corners).reshape(-1, 3)
    unique, inverse = np.unique(
        corners.astype(np.float32), axis=0, return_inverse=True
    )
    return (
        unique.astype(np.float64),
        inverse.reshape(-1, 3),
        np.concatenate(face_material),
        material_map(data),
    )


def add_view_scene(bounds_min, bounds_max) -> None:
    scene = bpy.context.scene
    size = bounds_max - bounds_min
    target = 0.5 * (bounds_min + bounds_max)
    target[1] = bounds_min[1] + 0.40 * size[1]
    yaw, pitch = -0.55, 0.62
    distance = 2.2 * 0.5 * float(np.linalg.norm(size))
    eye = target + distance * np.array(
        (
            math.cos(pitch) * math.sin(yaw),
            math.sin(pitch),
            math.cos(pitch) * math.cos(yaw),
        )
    )

    camera = bpy.data.cameras.new("RPD Camera")
    camera.lens = 50.0
    cam = bpy.data.objects.new("RPD Camera", camera)
    scene.collection.objects.link(cam)
    cam.location = to_blender(eye).tolist()
    cam.rotation_euler = (
        Vector(to_blender(target).tolist()) - cam.location
    ).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam

    light = bpy.data.lights.new("RPD Sun", type="SUN")
    light.energy = 3.0
    sun = bpy.data.objects.new("RPD Sun", light)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(55.0), 0.0, math.radians(35.0))

    world = bpy.data.worlds.new("RPD World")
    background = world.node_tree.nodes.get("Background")
    if background is not None:
        background.inputs["Color"].default_value = (0.05, 0.055, 0.065, 1.0)
        background.inputs["Strength"].default_value = 0.35
    scene.world = world


def import_rooms() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    materials: dict[tuple[str, int], object] = {}
    files = sorted(RAW.glob("*.mesh"), key=lambda p: (room_floor(p.stem), p.stem))
    if not files:
        sys.exit(f"no .mesh files in {RAW.relative_to(ROOT)}; run npm run data first")

    def material_for(room: str, index: int, names: list[str]):
        key = (room, index)
        existing = materials.get(key)
        if existing is not None:
            return existing
        label = names[index] if index < len(names) else f"material_{index}"
        mat = bpy.data.materials.new(f"{room} {index:02d} {label}"[:63])
        r, g, b = material_colour(index)
        colour = (r / 255.0, g / 255.0, b / 255.0, 1.0)
        mat.diffuse_color = colour
        shader = mat.node_tree.nodes.get("Principled BSDF")
        if shader is not None:
            shader.inputs["Base Color"].default_value = colour
            shader.inputs["Roughness"].default_value = 0.9
        materials[key] = mat
        return mat

    total = 0
    bounds_min = np.full(3, np.inf)
    bounds_max = np.full(3, -np.inf)
    all_min = np.full(3, np.inf)
    all_max = np.full(3, -np.inf)
    for path in files:
        room = path.stem
        floor = room_floor(room)
        verts, faces, face_material, names = read_room(path)

        mesh_data = bpy.data.meshes.new(room)
        mesh_data.from_pydata(verts.tolist(), [], faces.tolist())
        mesh_data.update()

        obj = bpy.data.objects.new(room, mesh_data)
        scene.collection.objects.link(obj)
        obj["rpd_room"] = room
        obj["rpd_floor"] = floor

        slots: dict[int, int] = {}
        for index in sorted(set(face_material.tolist())):
            mesh_data.materials.append(material_for(room, index, names))
            slots[index] = len(mesh_data.materials) - 1
        mesh_data.polygons.foreach_set(
            "material_index",
            np.array([slots[i] for i in face_material.tolist()], dtype=np.int32),
        )

        source = from_blender(verts)
        all_min = np.minimum(all_min, source.min(axis=0))
        all_max = np.maximum(all_max, source.max(axis=0))
        inside = np.all((source >= FRAME_MIN) & (source <= FRAME_MAX), axis=1)
        if np.any(inside):
            bounds_min = np.minimum(bounds_min, source[inside].min(axis=0))
            bounds_max = np.maximum(bounds_max, source[inside].max(axis=0))

        total += len(faces)
        print(
            f"  {room}: {len(verts):,} verts, {len(faces):,} tris, floor {floor + 1}"
        )

    if total != EXPECTED_TRIANGLES:
        sys.exit(
            f"imported {total:,} triangles from {len(files)} meshes, "
            f"expected {EXPECTED_TRIANGLES:,}"
        )

    if not np.all(np.isfinite(bounds_min)):
        bounds_min, bounds_max = all_min, all_max

    add_view_scene(bounds_min, bounds_max)
    scene["rpd_triangles"] = total

    BLEND.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND))
    print(
        f"wrote {BLEND.relative_to(ROOT)}: {len(files)} rooms, "
        f"{len(materials)} materials, {total:,} triangles"
    )


class Chunk:
    def __init__(self, floor: int):
        self.floor = floor
        self.verts = array.array("f")
        self.colours = array.array("B")
        self.indices = array.array("H")
        self.lookup: dict[tuple[int, int, int, tuple[int, int, int]], int] = {}

    def __len__(self):
        return len(self.verts) // 3

    def add(self, position, colour) -> int:
        key = (
            int(round(float(position[0]) * QUANT)),
            int(round(float(position[1]) * QUANT)),
            int(round(float(position[2]) * QUANT)),
            colour,
        )
        found = self.lookup.get(key)
        if found is not None:
            return found
        found = len(self.verts) // 3
        if found >= 65536:
            raise OverflowError
        self.lookup[key] = found
        self.verts.extend((position[0], position[1], position[2]))
        self.colours.extend(colour)
        return found

    def triangle(self, positions, tri, colour) -> None:
        self.indices.extend(
            (
                self.add(positions[tri[0]], colour),
                self.add(positions[tri[1]], colour),
                self.add(positions[tri[2]], colour),
            )
        )


def export_asset() -> None:
    scene = bpy.context.scene
    expected = scene.get("rpd_triangles")
    if expected is None:
        sys.exit("scene has no rpd_triangles property; run scene:import first")

    objects = []
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        data = obj.data
        if len(data.vertices) == 0:
            continue
        count = len(data.vertices)
        co = np.empty(count * 3, dtype=np.float64)
        data.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        matrix = np.array(obj.matrix_world)
        co = co @ matrix[:3, :3].T + matrix[:3, 3]
        co = from_blender(co)

        data.calc_loop_triangles()
        triangles = len(data.loop_triangles)
        if triangles == 0:
            continue
        index = np.empty(triangles * 3, dtype=np.int32)
        data.loop_triangles.foreach_get("vertices", index)
        index = index.reshape(-1, 3)
        face_material = np.empty(triangles, dtype=np.int32)
        data.loop_triangles.foreach_get("material_index", face_material)

        colours = []
        for slot in data.materials:
            rgba = slot.diffuse_color if slot is not None else (0.55, 0.55, 0.55, 1.0)
            colours.append(
                (
                    min(255, int(round(rgba[0] * 255))),
                    min(255, int(round(rgba[1] * 255))),
                    min(255, int(round(rgba[2] * 255))),
                )
            )
        if not colours:
            colours = [(140, 140, 140)]
        face_colour = [
            colours[i] if 0 <= i < len(colours) else colours[0]
            for i in face_material.tolist()
        ]
        stored = obj.get("rpd_floor")
        if stored is not None:
            floor = int(stored)
        else:
            floor = floor_from_height(float(np.median(co[:, 1])))
        objects.append((floor, obj.name, co, index.tolist(), face_colour))

    if not objects:
        sys.exit("no mesh objects in the scene")

    objects.sort(key=lambda item: (item[0], item[1]))
    chunks: list[Chunk] = []
    current: Chunk | None = None
    for floor, _name, positions, index, face_colour in objects:
        for tri, colour in zip(index, face_colour):
            if current is None:
                current = Chunk(floor)
            try:
                current.triangle(positions, tri, colour)
            except OverflowError:
                chunks.append(current)
                current = Chunk(floor)
                current.triangle(positions, tri, colour)
            if len(current) >= MAX_CHUNK_VERTS:
                chunks.append(current)
                current = None
    if current is not None and len(current):
        chunks.append(current)

    packed = []
    total_v = 0
    total_t = 0
    for chunk in chunks:
        if not chunk.indices:
            continue
        pts = np.frombuffer(chunk.verts, dtype=np.float32).reshape(-1, 3)
        origin = pts.min(axis=0)
        extent = float((pts.max(axis=0) - origin).max())
        scale = extent / 65535.0 if extent > 1e-6 else 1.0
        q = np.clip(np.rint((pts - origin) / scale), 0, 65535).astype(np.uint16)
        colours = np.frombuffer(chunk.colours, dtype=np.uint8).reshape(-1, 3)
        indices = np.frombuffer(chunk.indices, dtype=np.uint16)
        packed.append((chunk.floor, origin, scale, q, colours, indices))
        total_v += len(q)
        total_t += len(indices) // 3

    if total_t != int(expected):
        sys.exit(
            f"exported {total_t:,} triangles but the scene recorded {int(expected):,}. "
            "If you changed the geometry on purpose, update the rpd_triangles "
            "custom property on the scene."
        )

    points = [
        origin + q.astype(np.float64) * scale
        for _f, origin, scale, q, _c, _i in packed
    ]
    allpts = np.concatenate([p for p in points if len(p)], axis=0)
    inside = np.all((allpts >= FRAME_MIN) & (allpts <= FRAME_MAX), axis=1)
    framing = allpts[inside] if np.any(inside) else allpts
    bounds_min = framing.min(axis=0)
    bounds_max = framing.max(axis=0)
    floor_bounds = [[1e9, -1e9] for _ in range(3)]
    for (floor, origin, scale, q, _c, _i), pts in zip(packed, points):
        p = origin + q.astype(np.float64) * scale
        mask = np.all((p >= FRAME_MIN) & (p <= FRAME_MAX), axis=1)
        if np.any(mask):
            floor_bounds[floor][0] = min(
                floor_bounds[floor][0], float(p[mask, 1].min())
            )
            floor_bounds[floor][1] = max(
                floor_bounds[floor][1], float(p[mask, 1].max())
            )

    OUT_BIN.parent.mkdir(parents=True, exist_ok=True)
    with OUT_BIN.open("wb") as f:
        f.write(b"RPDW")
        f.write(struct.pack("<IIIIII", VERSION, len(packed), total_v, total_t, 3, 0))
        f.write(struct.pack("<3f", *bounds_min.astype(np.float32)))
        f.write(struct.pack("<3f", *bounds_max.astype(np.float32)))
        for floor in range(3):
            start = sum(1 for p in packed if p[0] < floor)
            count = sum(1 for p in packed if p[0] == floor)
            y0, y1 = floor_bounds[floor]
            f.write(struct.pack("<IIff", start, count, y0, y1))
        for floor, origin, scale, q, colours, indices in packed:
            f.write(struct.pack("<IIII", len(q), len(indices), floor, 0))
            f.write(struct.pack("<3f", *origin))
            f.write(struct.pack("<f", scale))
            f.write(q.astype("<u2").tobytes())
            f.write(colours.tobytes())
            f.write(indices.astype("<u2").tobytes())
            while f.tell() % 4:
                f.write(b"\0")

    meta = {
        "asset": OUT_BIN.name,
        "version": VERSION,
        "method": "Blender scene exported to RPDW, flat material colours",
        "vertices": total_v,
        "triangles": total_t,
        "chunks": len(packed),
        "bytes": OUT_BIN.stat().st_size,
        "bounds": {"min": bounds_min.tolist(), "max": bounds_max.tolist()},
        "floors": [
            {
                "floor": i + 1,
                "y_min": floor_bounds[i][0],
                "y_max": floor_bounds[i][1],
                "chunks": sum(1 for p in packed if p[0] == i),
            }
            for i in range(3)
        ],
        "filters": {"geometry": "every mesh object in the scene"},
    }
    OUT_JSON.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {OUT_BIN.relative_to(ROOT)}: {total_v:,} vertices, "
        f"{total_t:,} triangles, {len(packed)} chunks, "
        f"{meta['bytes'] / 1e6:.1f} MB"
    )
    for entry in meta["floors"]:
        print(
            f"  floor {entry['floor']}: y {entry['y_min']:.2f}..{entry['y_max']:.2f}, "
            f"{entry['chunks']} chunks"
        )


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--import", dest="do_import", action="store_true")
    group.add_argument("--export", dest="do_export", action="store_true")
    args = parser.parse_args(argv)
    if args.do_import:
        import_rooms()
    else:
        export_asset()


if __name__ == "__main__":
    main()
