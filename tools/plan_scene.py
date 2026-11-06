#!/usr/bin/env python3
"""Build the paper-model RPD from ``public/rpd/plan.json`` and export the asset.

Every wall, floor slab and stair tread in ``plan.json`` is an axis-aligned box.
The script turns those boxes into one Blender object per floor, saves
``build/rpd_plan.blend`` and writes the viewer asset ``public/rpd/rpd.bin``
(RPDW version 4, five floors).

Run with::

    blender -b -P tools/plan_scene.py
"""
from __future__ import annotations

import json
import math
import pathlib
import struct
import sys

import bpy
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
PLAN = ROOT / "public" / "rpd" / "plan.json"
BLEND = ROOT / "build" / "rpd_plan.blend"
OUT_BIN = ROOT / "public" / "rpd" / "rpd.bin"
OUT_JSON = ROOT / "public" / "rpd" / "rpd.json"

VERSION = 4
QUANT = 1000.0


def box_vertices(box):
    x0, x1 = box["x0"], box["x1"]
    y0, y1 = box["y0"], box["y1"]
    z0, z1 = box["z0"], box["z1"]
    return [
        (x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1),
        (x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1),
    ]


BOX_FACES = [
    (0, 3, 2, 1),  # bottom
    (4, 5, 6, 7),  # top
    (0, 1, 5, 4),  # front
    (1, 2, 6, 5),  # right
    (2, 3, 7, 6),  # back
    (3, 0, 4, 7),  # left
]


def build_blend(plan: dict) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    for floor in plan["floors"]:
        verts: list[tuple[float, float, float]] = []
        faces: list[tuple[int, int, int, int]] = []
        material_index: list[int] = []
        materials: list[tuple[int, int, int]] = []
        palette: dict[tuple[int, int, int], int] = {}
        for box in floor["boxes"]:
            base = len(verts)
            verts.extend(box_vertices(box))
            colour = tuple(box["c"])
            slot = palette.get(colour)
            if slot is None:
                slot = len(materials)
                palette[colour] = slot
                materials.append(colour)
            for face in BOX_FACES:
                faces.append(tuple(base + i for i in face))
                material_index.append(slot)
        mesh = bpy.data.meshes.new(f"RPD {floor['label']}")
        mesh.from_pydata(verts, [], faces)
        mesh.update()
        for colour in materials:
            mat = bpy.data.materials.new(f"{floor['label']} {colour}")
            rgba = (colour[0] / 255.0, colour[1] / 255.0, colour[2] / 255.0, 1.0)
            mat.diffuse_color = rgba
            shader = mat.node_tree.nodes.get("Principled BSDF")
            if shader is not None:
                shader.inputs["Base Color"].default_value = rgba
                shader.inputs["Roughness"].default_value = 0.95
            mesh.materials.append(mat)
        mesh.polygons.foreach_set("material_index", np.array(material_index, dtype=np.int32))
        obj = bpy.data.objects.new(f"RPD {floor['label']}", mesh)
        obj["rpd_floor"] = floor["index"]
        scene.collection.objects.link(obj)

    # A simple paper-white studio light for preview renders.
    world = bpy.data.worlds.new("Paper")
    background = world.node_tree.nodes.get("Background")
    if background is not None:
        background.inputs["Color"].default_value = (0.95, 0.94, 0.90, 1.0)
        background.inputs["Strength"].default_value = 0.8
    scene.world = world
    if scene.camera is None:
        camera = bpy.data.cameras.new("Plan Camera")
        cam = bpy.data.objects.new("Plan Camera", camera)
        scene.collection.objects.link(cam)
        cam.location = (90.0, -90.0, 120.0)
        cam.rotation_euler = (math.radians(55.0), 0.0, math.radians(45.0))
        scene.camera = cam
    BLEND.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND))
    print(f"wrote {BLEND.relative_to(ROOT)}")


class Chunk:
    def __init__(self, floor: int):
        self.floor = floor
        self.verts: list[tuple[float, float, float]] = []
        self.colours: list[tuple[int, int, int]] = []
        self.indices: list[int] = []
        self.lookup: dict[tuple[int, int, int, tuple[int, int, int]], int] = {}

    def add(self, position, colour) -> int:
        key = (
            int(round(position[0] * QUANT)),
            int(round(position[1] * QUANT)),
            int(round(position[2] * QUANT)),
            colour,
        )
        found = self.lookup.get(key)
        if found is not None:
            return found
        found = len(self.verts)
        if found >= 65536:
            raise OverflowError
        self.lookup[key] = found
        self.verts.append(tuple(position))
        self.colours.append(colour)
        return found

    def triangle(self, positions, tri, colour) -> None:
        self.indices.extend(
            (self.add(positions[tri[0]], colour),
             self.add(positions[tri[1]], colour),
             self.add(positions[tri[2]], colour))
        )


def export(plan: dict) -> None:
    chunks: list[Chunk] = []
    for floor in plan["floors"]:
        current = Chunk(floor["index"])
        for box in floor["boxes"]:
            positions = box_vertices(box)
            colour = tuple(box["c"])
            tris = [
                (0, 3, 2), (0, 2, 1),
                (4, 5, 6), (4, 6, 7),
                (0, 1, 5), (0, 5, 4),
                (1, 2, 6), (1, 6, 5),
                (2, 3, 7), (2, 7, 6),
                (3, 0, 4), (3, 4, 7),
            ]
            if box.get("faces") == "top":
                tris = [(4, 5, 6), (4, 6, 7)]
            try:
                for tri in tris:
                    current.triangle(positions, tri, colour)
            except OverflowError:
                chunks.append(current)
                current = Chunk(floor["index"])
                for tri in tris:
                    current.triangle(positions, tri, colour)
            if len(current.verts) > 60000:
                chunks.append(current)
                current = Chunk(floor["index"])
        if len(current.verts):
            chunks.append(current)

    packed = []
    total_v = total_t = 0
    for chunk in chunks:
        pts = np.array(chunk.verts, dtype=np.float64)
        origin = pts.min(axis=0)
        extent = float((pts.max(axis=0) - origin).max())
        scale = extent / 65535.0 if extent > 1e-6 else 1.0
        q = np.clip(np.rint((pts - origin) / scale), 0, 65535).astype(np.uint16)
        packed.append((chunk.floor, origin, scale, q, np.array(chunk.colours, np.uint8),
                       np.array(chunk.indices, np.uint16)))
        total_v += len(q)
        total_t += len(chunk.indices) // 3

    allpts = np.concatenate([origin + q.astype(np.float64) * scale for _f, origin, scale, q, _c, _i in packed])
    bounds_min = allpts.min(axis=0)
    bounds_max = allpts.max(axis=0)
    floor_count = len(plan["floors"])
    floor_bounds = [[1e9, -1e9] for _ in range(floor_count)]
    for floor, origin, scale, q, _c, _i in packed:
        p = origin + q.astype(np.float64) * scale
        floor_bounds[floor][0] = min(floor_bounds[floor][0], float(p[:, 1].min()))
        floor_bounds[floor][1] = max(floor_bounds[floor][1], float(p[:, 1].max()))

    with OUT_BIN.open("wb") as f:
        f.write(b"RPDW")
        f.write(struct.pack("<IIIIII", VERSION, len(packed), total_v, total_t, floor_count, 0))
        f.write(struct.pack("<3f", *bounds_min.astype(np.float32)))
        f.write(struct.pack("<3f", *bounds_max.astype(np.float32)))
        for floor in range(floor_count):
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
        "method": "Blender paper model built from calibrated floor plans",
        "vertices": total_v,
        "triangles": total_t,
        "chunks": len(packed),
        "bytes": OUT_BIN.stat().st_size,
        "bounds": {"min": bounds_min.tolist(), "max": bounds_max.tolist()},
        "floors": [
            {"index": floor["index"], "label": floor["label"], "level": floor["level"],
             "y_min": floor_bounds[floor["index"]][0], "y_max": floor_bounds[floor["index"]][1],
             "chunks": sum(1 for p in packed if p[0] == floor["index"])}
            for floor in plan["floors"]
        ],
    }
    OUT_JSON.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT_BIN.relative_to(ROOT)}: {total_v:,} verts, {total_t:,} tris, {len(packed)} chunks")
    for entry in meta["floors"]:
        print(f"  {entry['label']}: y {entry['y_min']:.2f}..{entry['y_max']:.2f}, {entry['chunks']} chunks")


def main() -> int:
    plan = json.loads(PLAN.read_text(encoding="utf-8"))
    build_blend(plan)
    export(plan)
    return 0


if __name__ == "__main__":
    sys.exit(main())
