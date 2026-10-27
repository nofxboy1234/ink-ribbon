#!/usr/bin/env python3
"""Build the real LOD-0 RPD geometry with flat material colours.

No simplification, no texture coordinates. Each source material subdivision
gets one simple colour. Distant backdrop, degenerates and flat top-envelope
surfaces are trimmed; the real building shell is otherwise kept.
"""
from __future__ import annotations

import argparse
import array
import colorsys
import json
import pathlib
import struct

import numpy as np

import remesh

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "rpd"
OUT_BIN = ROOT / "public" / "rpd" / "rpd.bin"
OUT_JSON = ROOT / "public" / "rpd" / "rpd.json"

FLOOR_OF_ROOM = {"1": 0, "2": 0, "3": 0, "4": 1, "5": 1, "6": 2}
CLIP_MIN = np.array([-60.0, -8.0, -40.0], dtype=np.float64)
CLIP_MAX = np.array([55.0, 55.0, 30.0], dtype=np.float64)
CEILING_CUT = 1.6
MAX_CHUNK_VERTS = 60000
VERSION = 3


def room_floor(room: str) -> int:
    return FLOOR_OF_ROOM[room.split("_")[1][0]]


def material_colour(index: int):
    """Muted, simple material palette; no texture lookups anywhere."""
    palette = (
        (0.63, 0.61, 0.56),  # limestone / plaster
        (0.49, 0.49, 0.48),  # concrete
        (0.55, 0.44, 0.36),  # wood
        (0.39, 0.43, 0.47),  # blue-grey metal
        (0.68, 0.65, 0.59),  # pale stone
        (0.31, 0.33, 0.35),  # dark metal
        (0.57, 0.51, 0.43),  # tan
        (0.44, 0.47, 0.43),  # muted green-grey
        (0.60, 0.47, 0.42),  # muted brick
        (0.50, 0.38, 0.34),  # dark wood
        (0.71, 0.69, 0.64),  # light stone
        (0.35, 0.38, 0.41),  # slate
    )
    r, g, b = palette[index % len(palette)]
    lift = 0.025 * (index // len(palette))
    return (
        min(255, int((r + lift) * 255)),
        min(255, int((g + lift) * 255)),
        min(255, int((b + lift) * 255)),
    )


def submesh_triangles(mesh, group, sub):
    index_size = 4 if mesh.has_32bit_indices else 2
    fmt = "<%dI" if index_size == 4 else "<%dH"
    count = sub.index_count
    raw = struct.unpack_from(fmt % count, mesh.index_buffer, sub.index_start * index_size)
    group_base = remesh.group_vertex_base(group)
    local = sub.vertex_start - group_base
    for i in range(0, count, 3):
        yield raw[i] + local, raw[i + 1] + local, raw[i + 2] + local


class Chunk:
    def __init__(self, floor: int):
        self.floor = floor
        self.verts = array.array("f")
        self.cols = array.array("B")
        self.indices = array.array("H")
        self.lookup: dict[tuple[int, int, int, int], int] = {}

    def __len__(self):
        return len(self.verts) // 3

    def add(self, p, colour_index):
        key = (
            int(round(p[0] * 1000)),
            int(round(p[1] * 1000)),
            int(round(p[2] * 1000)),
            colour_index,
        )
        idx = self.lookup.get(key)
        if idx is None:
            idx = len(self.verts) // 3
            if idx >= 65536:
                raise OverflowError
            self.lookup[key] = idx
            self.verts.extend((p[0], p[1], p[2]))
            r, g, b = material_colour(colour_index)
            self.cols.extend((r, g, b))
        return idx

    def triangle(self, a, b, c, colour_index):
        i0 = self.add(a, colour_index)
        i1 = self.add(b, colour_index)
        i2 = self.add(c, colour_index)
        self.indices.extend((i0, i1, i2))


def load_triangles():
    files = sorted(RAW.glob("*.mesh"), key=lambda p: (room_floor(p.stem), p.stem))
    floors = []
    for path in files:
        mesh = remesh.parse(path.read_bytes())
        lod = mesh.lods[0]
        room_top = max(
            (max(p[1] for p in remesh.positions(mesh, g)) for g in lod.groups),
            default=0.0,
        )
        tris = []
        for group in lod.groups:
            pos = np.asarray(remesh.positions(mesh, group), dtype=np.float64)
            for sub in group.submeshes:
                if sub.is_quad or sub.index_count == 0:
                    continue
                for a, b, c in submesh_triangles(mesh, group, sub):
                    p0, p1, p2 = pos[a], pos[b], pos[c]
                    if np.any(p0 < CLIP_MIN) or np.any(p0 > CLIP_MAX):
                        continue
                    if np.any(p1 < CLIP_MIN) or np.any(p1 > CLIP_MAX):
                        continue
                    if np.any(p2 < CLIP_MIN) or np.any(p2 > CLIP_MAX):
                        continue
                    n = np.cross(p1 - p0, p2 - p0)
                    area = float(np.linalg.norm(n)) * 0.5
                    if area < 1e-5:
                        continue
                    ny = n[1] / (2.0 * area)
                    cy = (p0[1] + p1[1] + p2[1]) / 3.0
                    if ny > 0.6 and cy > room_top - CEILING_CUT:
                        continue
                    tris.append((sub.material, (p0, p1, p2)))
        floors.append((path.stem, room_floor(path.stem), tris))
    return floors


def build():
    floors = load_triangles()
    chunks: list[Chunk] = []
    current = None
    for _room, floor, tris in floors:
        for material, tri in tris:
            if current is None:
                current = Chunk(floor)
            try:
                current.triangle(tri[0], tri[1], tri[2], material)
            except OverflowError:
                chunks.append(current)
                current = Chunk(floor)
                current.triangle(tri[0], tri[1], tri[2], material)
            if len(current) >= MAX_CHUNK_VERTS:
                chunks.append(current)
                current = None
    if current is not None and len(current):
        chunks.append(current)

    packed = []
    total_v = 0
    total_t = 0
    for c in chunks:
        nv = len(c)
        ni = len(c.indices)
        if nv == 0 or ni == 0:
            continue
        pts = np.frombuffer(c.verts, dtype=np.float32).reshape(-1, 3)
        origin = pts.min(axis=0)
        extent = float((pts.max(axis=0) - origin).max())
        scale = extent / 65535.0 if extent > 1e-6 else 1.0
        q = np.clip(np.rint((pts - origin) / scale), 0, 65535).astype(np.uint16)
        packed.append((c.floor, origin.astype(np.float32), scale, q, c.cols, c.indices))
        total_v += nv
        total_t += ni // 3

    bounds_min = np.array([1e9, 1e9, 1e9])
    bounds_max = np.array([-1e9, -1e9, -1e9])
    floor_bounds = [[1e9, -1e9] for _ in range(3)]
    for floor, origin, scale, q, cols, idx in packed:
        mx = origin + q.astype(np.float64) * scale
        bounds_min = np.minimum(bounds_min, mx.min(axis=0))
        bounds_max = np.maximum(bounds_max, mx.max(axis=0))
        floor_bounds[floor][0] = min(floor_bounds[floor][0], float(mx[:, 1].min()))
        floor_bounds[floor][1] = max(floor_bounds[floor][1], float(mx[:, 1].max()))

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
        for floor, origin, scale, q, cols, idx in packed:
            f.write(struct.pack("<IIII", len(q), len(idx), floor, 0))
            f.write(struct.pack("<3f", *origin))
            f.write(struct.pack("<f", scale))
            f.write(q.astype("<u2").tobytes())
            f.write(bytes(cols))
            f.write(np.asarray(idx, dtype="<u2").tobytes())
            while f.tell() % 4:
                f.write(b"\0")

    materials = sorted({m for _r, _f, tris in floors for m, _t in tris})
    meta = {
        "asset": OUT_BIN.name,
        "version": VERSION,
        "method": "real LOD-0 geometry, flat material colours",
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
        "materials": {str(m): list(material_colour(m)) for m in materials},
        "filters": {"clip": [CLIP_MIN.tolist(), CLIP_MAX.tolist()], "ceiling_cut": CEILING_CUT},
    }
    OUT_JSON.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {OUT_BIN.relative_to(ROOT)}: {total_v:,} vertices, "
        f"{total_t:,} triangles, {len(packed)} chunks, "
        f"{meta['bytes'] / 1e6:.1f} MB"
    )
    for fl in meta["floors"]:
        print(f"  floor {fl['floor']}: y {fl['y_min']:.2f}..{fl['y_max']:.2f}, {fl['chunks']} chunks")


if __name__ == "__main__":
    build()
