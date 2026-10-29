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
    ("sm41_024_newpolicestatue01a", 0, (0.0, 1.55, -13.29)),
    ("sm46_011_crashheli01a", 1, (26.1, 5.2, -9.95)),
)


# Gaps the decompiled meshes leave open. Each entry adds a floor quad, plus
# walls on any named side. Sides: "w" low x, "e" high x, "s" low z, "n" high z.
FILL_SPECS = (
    # The statue prop is a half-basin, so its south side is open over the void
    # between the two grand flights. A plinth plate at 0.79 closes the view
    # through it and gives the basin rim a floor to sit on.
    {"floor": 0, "x": (-3.9, 3.9), "z": (-16.0, -9.6), "y": 0.79, "walls": ()},
    # 2F east floor the meshes leave out. Both rings come from the marked
    # outline unprojected through the reported camera and clipped to the shell.
    {
        "floor": 1,
        "y": 5.20,
        "walls": (),
        "ring": [
            [32.12, -3.16], [33.46, -3.17], [33.43, -2.82], [32.88, -2.82],
            [32.85, -3.01], [32.2, -3.01], [33.55, -0.64], [35.64, -0.54],
            [40.15, -0.54], [40.18, -0.87], [40.72, -0.88], [40.77, -0.54],
            [42.88, -0.54], [42.82, -0.62], [42.82, -3.12], [42.63, -3.19],
            [41.07, -3.19], [40.89, -3.12], [40.86, -3.02], [40.77, -3.06],
            [40.74, -2.82], [40.16, -2.84], [40.17, -3.19], [40.63, -3.2],
            [40.61, -4.9], [40.35, -5.05], [40.27, -5.04], [40.23, -3.36],
            [33.02, -3.36], [32.97, -3.49],
        ],
    },
    # The recess the yellow notes mark, west of the two rings above.
    {"floor": 1, "x": (30.6, 34.6), "z": (-5.0, 1.0), "y": 5.20, "walls": ()},
    {
        "floor": 1,
        "y": 5.20,
        "walls": (),
        "ring": [
            [43.44, -0.17], [48.11, 0.06], [48.57, 0.05], [48.36, -0.32],
            [43.44, -3.23],
        ],
    },
)


def _triangulate(ring):
    """Ear-clip a simple polygon given as (x, z) points."""
    pts = list(ring)
    if len(pts) < 3:
        return []
    area = 0.0
    for i in range(len(pts)):
        x0, z0 = pts[i]
        x1, z1 = pts[(i + 1) % len(pts)]
        area += x0 * z1 - x1 * z0
    if area < 0:
        pts.reverse()
    out = []
    guard = 0
    while len(pts) > 3 and guard < 10000:
        guard += 1
        clipped = False
        for i in range(len(pts)):
            ax, az = pts[i - 1]
            bx, bz = pts[i]
            cx, cz = pts[(i + 1) % len(pts)]
            cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
            if cross <= 1e-9:
                continue
            inside = False
            for px, pz in pts:
                if (px, pz) in ((ax, az), (bx, bz), (cx, cz)):
                    continue
                d1 = (bx - ax) * (pz - az) - (bz - az) * (px - ax)
                d2 = (cx - bx) * (pz - bz) - (cz - bz) * (px - bx)
                d3 = (ax - cx) * (pz - cz) - (az - cz) * (px - cx)
                if d1 >= 0 and d2 >= 0 and d3 >= 0:
                    inside = True
                    break
            if inside:
                continue
            out.append(((ax, az), (bx, bz), (cx, cz)))
            del pts[i]
            clipped = True
            break
        if not clipped:
            break
    if len(pts) == 3:
        out.append(tuple(pts))
    return out


# Vertical panels the meshes leave out. axis "x" means the panel sits at a
# constant x and runs along z; axis "z" is the mirror.
PANEL_SPECS = (
    # 2F wall between the east corridor and the annex. Both pink views agree
    # on the plane x = 38.5; the meshes carry 3.9 m2 here against 127 m2 below.
    # Empty: the pink plane carries 43.6 m2 of 2F wall already, so a panel
    # there is coplanar and invisible. Kept as the lever for the next edge.

)


def load_panel_triangles():
    out = []
    colour = MANUAL_MATERIAL
    for spec in PANEL_SPECS:
        u0, u1 = spec["u"]
        y0, y1 = spec["y"]
        a = spec["at"]
        if spec["axis"] == "x":
            quad = ((a, y0, u0), (a, y0, u1), (a, y1, u1), (a, y1, u0))
        else:
            quad = ((u0, y0, a), (u1, y0, a), (u1, y1, a), (u0, y1, a))
        out.append((colour, (quad[0], quad[1], quad[2])))
        out.append((colour, (quad[0], quad[2], quad[3])))
    return out


def load_fill_triangles():
    """Synthetic quads that close holes the decompiled meshes leave open."""
    out = []
    for spec in FILL_SPECS:
        y = spec["y"]
        colour = MANUAL_MATERIAL
        if "ring" in spec:
            for tri in _triangulate(spec["ring"]):
                out.append(
                    (
                        colour,
                        tuple((float(px), y, float(pz)) for px, pz in tri),
                    )
                )
            continue
        x0, x1 = spec["x"]
        z0, z1 = spec["z"]
        out.append((colour, ((x0, y, z0), (x1, y, z0), (x1, y, z1))))
        out.append((colour, ((x0, y, z0), (x1, y, z1), (x0, y, z1))))
        top = spec.get("wall_top")
        for side in spec.get("walls", ()):
            if side == "w":
                quad = ((x0, y, z0), (x0, y, z1), (x0, top, z1), (x0, top, z0))
            elif side == "e":
                quad = ((x1, y, z1), (x1, y, z0), (x1, top, z0), (x1, top, z1))
            elif side == "s":
                quad = ((x1, y, z0), (x0, y, z0), (x0, top, z0), (x1, top, z0))
            else:
                quad = ((x0, y, z1), (x1, y, z1), (x1, top, z1), (x0, top, z1))
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
        floors.append(("fill", 0, list(fills)))
    panels = load_panel_triangles()
    if panels:
        floors.append(("panel", 1, list(panels)))
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
