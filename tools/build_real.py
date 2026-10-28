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
FRAME_MIN = np.array([-60.0, -8.0, -40.0], dtype=np.float64)
FRAME_MAX = np.array([55.0, 55.0, 30.0], dtype=np.float64)
MAX_CHUNK_VERTS = 60000
VERSION = 3


def room_floor(room: str) -> int:
    return FLOOR_OF_ROOM[room.split("_")[1][0]]


def material_colour(index: int):
    """Neutral grey material palette; no texture lookups anywhere."""
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


MANUAL_MATERIAL = 10

PROP_SPECS = (
    # The statue prop includes the half-basin. Its basin centre (local
    # 0, 1.82) is aligned to the mid-point of the hall floor chord at
    # (0, -11.47), and its rim sits at the hall floor level of 0.80.
    ("sm41_024_newpolicestatue01a", 0, (0.0, 1.75, -13.29)),
    ("sm46_011_crashheli01a", 1, (26.1, 5.2, -9.95)),
)


# Gaps in the decompiled meshes that leave a see-through hole. Each entry adds
# a floor quad, and walls on any named side, so the shell is closed again.
# Sides: "w" low x, "e" high x, "s" low z, "n" high z.
FILL_SPECS = (
    # Floor strip between the main hall and the east wing, 2F. The meshes leave
    # a 3.6 x 0.9 m opening here, which renders as a black slot.
    {
        "floor": 1,
        "x": (8.8, 12.4),
        "z": (-26.2, -25.3),
        "y": 5.20,
        "ceiling": None,
        "walls": (),
        "wall_top": 9.20,
    },
)


def load_fill_triangles():
    """Synthetic quads that close holes the decompiled meshes leave open."""
    out = []
    for spec in FILL_SPECS:
        x0, x1 = spec["x"]
        z0, z1 = spec["z"]
        y = spec["y"]
        colour = MANUAL_MATERIAL
        # Floor, wound counter-clockwise seen from above.
        out.append((colour, ((x0, y, z0), (x1, y, z0), (x1, y, z1))))
        out.append((colour, ((x0, y, z0), (x1, y, z1), (x0, y, z1))))
        if spec.get("ceiling") is not None:
            top = spec["ceiling"]
            out.append((colour, ((x0, top, z0), (x1, top, z1), (x1, top, z0))))
            out.append((colour, ((x0, top, z0), (x0, top, z1), (x1, top, z1))))
        base = y
        top = spec.get("wall_top", y + 4.0)
        for side in spec.get("walls", ()):
            if side == "w":
                quad = ((x0, base, z0), (x0, base, z1), (x0, top, z1), (x0, top, z0))
            elif side == "e":
                quad = ((x1, base, z1), (x1, base, z0), (x1, top, z0), (x1, top, z1))
            elif side == "s":
                quad = ((x1, base, z0), (x0, base, z0), (x0, top, z0), (x1, top, z0))
            else:
                quad = ((x0, base, z1), (x1, base, z1), (x1, top, z1), (x0, top, z1))
            out.append((colour, (quad[0], quad[1], quad[2])))
            out.append((colour, (quad[0], quad[2], quad[3])))
    return out


def load_prop_triangles():
    props_dir = ROOT / "data" / "raw" / "props"
    loaded = []
    for name, floor, offset in PROP_SPECS:
        path = props_dir / f"{name}.mesh"
        if not path.exists():
            continue
        mesh = remesh.parse(path.read_bytes())
        tris = []
        ox, oy, oz = offset
        for group in mesh.lods[0].groups:
            pos = np.asarray(remesh.positions(mesh, group), dtype=np.float64)
            for sub in group.submeshes:
                if sub.is_quad or sub.index_count == 0:
                    continue
                for a, b, c in submesh_triangles(mesh, group, sub):
                    p0 = pos[a] + (ox, oy, oz)
                    p1 = pos[b] + (ox, oy, oz)
                    p2 = pos[c] + (ox, oy, oz)
                    tris.append((sub.material, (p0, p1, p2)))
        loaded.append((name, floor, tris))
    return loaded


def load_triangles():
    files = sorted(RAW.glob("*.mesh"), key=lambda p: (room_floor(p.stem), p.stem))
    floors = []
    for path in files:
        mesh = remesh.parse(path.read_bytes())
        lod = mesh.lods[0]
        tris = []
        for group in lod.groups:
            pos = np.asarray(remesh.positions(mesh, group), dtype=np.float64)
            for sub in group.submeshes:
                if sub.is_quad or sub.index_count == 0:
                    continue
                for a, b, c in submesh_triangles(mesh, group, sub):
                    tris.append((sub.material, (pos[a], pos[b], pos[c])))
        floors.append((path.stem, room_floor(path.stem), tris))
    floors.extend(load_prop_triangles())
    return floors


def build():
    floors = load_triangles()
    fills = load_fill_triangles()
    if fills:
        floors.append(("fill", 1, list(fills)))
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

    points = [origin + q.astype(np.float64) * scale for _floor, origin, scale, q, _cols, _idx in packed]
    allpts = np.concatenate([p for p in points if len(p)], axis=0)
    inside = np.all((allpts >= FRAME_MIN) & (allpts <= FRAME_MAX), axis=1)
    framing = allpts[inside] if np.any(inside) else allpts
    bounds_min = framing.min(axis=0)
    bounds_max = framing.max(axis=0)
    floor_bounds = [[1e9, -1e9] for _ in range(3)]
    for (floor, origin, scale, q, _cols, _idx), pts in zip(packed, points):
        p = origin + q.astype(np.float64) * scale
        mask = np.all((p >= FRAME_MIN) & (p <= FRAME_MAX), axis=1)
        if np.any(mask):
            floor_bounds[floor][0] = min(floor_bounds[floor][0], float(p[mask, 1].min()))
            floor_bounds[floor][1] = max(floor_bounds[floor][1], float(p[mask, 1].max()))

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
        "filters": {"geometry": "all LOD-0 triangles; framing bounds only"},
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
