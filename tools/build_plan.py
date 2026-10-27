#!/usr/bin/env python3
"""Build a stylized floor-plan wireframe from the RPD terrain meshes.

The detailed triangle soup is reduced to three things the reference map does
well: large floor plates on a regular grid, simplified room walls, and
(simple) staircase runs. Props, mouldings, narrow trims and high-frequency
geometry are intentionally dropped.
"""

from __future__ import annotations

import argparse
import array
import json
import math
import pathlib
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from skimage.morphology import skeletonize

import remesh

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "rpd"
OUT_BIN = ROOT / "public" / "rpd" / "rpd.bin"
OUT_JSON = ROOT / "public" / "rpd" / "rpd.json"

FLOOR_OF_ROOM = {"1": 0, "2": 0, "3": 0, "4": 1, "5": 1, "6": 2}

# World bounds, matching the clip used by the previous mesh pass.
X0, Z0 = -60.0, -40.0
X1, Z1 = 55.0, 30.0
CELL = 0.5
NX = int(round((X1 - X0) / CELL))
NZ = int(round((Z1 - Z0) / CELL))

# One plate level per floor. The source floors are at roughly 0 / 5 / 10.25 m.
LEVELS = (0.0, 5.0, 10.25)
FLOOR_BASE = (-1.0, 4.2, 9.2)

TILE = 3.0                   # floor grid / tile size
TILE_CELLS = int(round(TILE / CELL))
FLOOR_MIN_AREA = 4.0         # m^2 per floor component
WALL_MIN_LENGTH = 1.5        # m
WALL_HEIGHT = 4.0            # m, cutaway wall height
FOOTPRINT_DILATE_M = 1.5
CEILING_CUT = 1.6


def room_floor(room: str) -> int:
    return FLOOR_OF_ROOM[room.split("_")[1][0]]


def grid_mask() -> Image.Image:
    return Image.new("1", (NX, NZ), 0)


def make_room_masks(rooms, floor: int, level: float, footprint: np.ndarray | None = None):
    masks = []
    for room in rooms:
        if room["floor"] != floor:
            continue
        im = grid_mask()
        draw = ImageDraw.Draw(im)
        for tri, y in zip(room["up_points"], room["up_y"]):
            if abs(y - level) > 1.5:
                continue
            draw.polygon(
                [((tri[i, 0] - X0) / CELL, (tri[i, 2] - Z0) / CELL) for i in range(3)],
                fill=1,
            )
        mask = np.asarray(im, dtype=bool).copy()
        if footprint is not None:
            mask &= footprint
        mask = filter_components(mask, 2.0)
        mask = fill_holes(mask)
        mask = filter_components(mask, FLOOR_MIN_AREA)
        if mask.any():
            masks.append(mask)
    return masks


def union_masks(masks) -> np.ndarray:
    out = np.zeros((NZ, NX), dtype=bool)
    for m in masks:
        out |= m
    return out


def label_components(mask: np.ndarray):
    seen = np.zeros_like(mask, dtype=bool)
    comps = []
    for iz in range(NZ):
        for ix in range(NX):
            if not mask[iz, ix] or seen[iz, ix]:
                continue
            stack = [(iz, ix)]
            seen[iz, ix] = True
            cells = []
            while stack:
                z, x = stack.pop()
                cells.append((z, x))
                for dz, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nz, nx = z + dz, x + dx
                    if 0 <= nz < NZ and 0 <= nx < NX and mask[nz, nx] and not seen[nz, nx]:
                        seen[nz, nx] = True
                        stack.append((nz, nx))
            comps.append(cells)
    return comps


def filter_components(mask: np.ndarray, min_area: float, min_extent: float = 1.0) -> np.ndarray:
    keep = np.zeros_like(mask, dtype=bool)
    for cells in label_components(mask):
        if len(cells) * CELL * CELL < min_area:
            continue
        zs = [c[0] for c in cells]
        xs = [c[1] for c in cells]
        if (max(xs) - min(xs) + 1) * CELL < min_extent:
            continue
        if (max(zs) - min(zs) + 1) * CELL < min_extent:
            continue
        for z, x in cells:
            keep[z, x] = True
    return keep


def fill_holes(mask: np.ndarray) -> np.ndarray:
    """Fill grid holes that are not connected to the grid border."""
    outside = np.zeros_like(mask, dtype=bool)
    stack = []
    for x in range(NX):
        if not mask[0, x]:
            stack.append((0, x))
        if not mask[NZ - 1, x]:
            stack.append((NZ - 1, x))
    for z in range(NZ):
        if not mask[z, 0]:
            stack.append((z, 0))
        if not mask[z, NX - 1]:
            stack.append((z, NX - 1))
    while stack:
        z, x = stack.pop()
        if outside[z, x] or mask[z, x]:
            continue
        outside[z, x] = True
        for dz, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nz, nx = z + dz, x + dx
            if 0 <= nz < NZ and 0 <= nx < NX and not outside[nz, nx] and not mask[nz, nx]:
                stack.append((nz, nx))
    return ~outside | mask


def mask_to_image(mask: np.ndarray) -> Image.Image:
    return Image.fromarray((mask.astype(np.uint8) * 255), mode="L")


def dilate(mask: np.ndarray, radius_m: float) -> np.ndarray:
    size = max(1, int(round(radius_m * 2 / CELL)) + 1)
    if size % 2 == 0:
        size += 1
    im = Image.fromarray(mask.astype(np.uint8) * 255, mode="L").filter(
        ImageFilter.MaxFilter(size)
    )
    return np.asarray(im) > 0


def main_rect_mask() -> np.ndarray:
    xs = np.arange(NX) * CELL + X0
    zs = np.arange(NZ) * CELL + Z0
    x = (xs >= -11.0) & (xs <= 11.0)
    z = (zs >= -23.0) & (zs <= 13.0)
    return z[:, None] & x[None, :]


# ---------------------------------------------------------------------------
# geometry writer
# ---------------------------------------------------------------------------


class MeshWriter:
    def __init__(self):
        self.positions = array.array("f")
        self.triangles = array.array("I")
        self.edges = array.array("I")
        self._verts: dict[tuple[int, int, int], int] = {}
        self._edges: set[tuple[int, int]] = set()
        self.floor_ranges = [
            {"tri_start": 0, "tri_count": 0, "edge_start": 0, "edge_count": 0}
            for _ in range(3)
        ]
        self.current_floor = 0
        self.floor_started = [False, False, False]

    def begin_floor(self, floor: int):
        self.current_floor = floor
        if not self.floor_started[floor]:
            self.floors_start(floor)

    def floors_start(self, floor: int):
        r = self.floor_ranges[floor]
        r["tri_start"] = len(self.triangles) // 3
        r["edge_start"] = len(self.edges) // 2
        self.floor_started[floor] = True

    def end_floor(self, floor: int):
        r = self.floor_ranges[floor]
        r["tri_count"] = len(self.triangles) // 3 - r["tri_start"]
        r["edge_count"] = len(self.edges) // 2 - r["edge_start"]

    def vert(self, x: float, y: float, z: float) -> int:
        key = (round(x * 1000), round(y * 1000), round(z * 1000))
        idx = self._verts.get(key)
        if idx is None:
            idx = len(self.positions) // 3
            self._verts[key] = idx
            self.positions.extend((x, y, z))
        return idx

    def tri(self, a: int, b: int, c: int):
        self.triangles.extend((a, b, c))

    def edge(self, a: int, b: int):
        if a == b:
            return
        key = (a, b) if a < b else (b, a)
        if key in self._edges:
            return
        self._edges.add(key)
        self.edges.extend(key)

    def quad(self, p0, p1, p2, p3, with_edges: bool = True):
        a = self.vert(*p0)
        b = self.vert(*p1)
        c = self.vert(*p2)
        d = self.vert(*p3)
        self.tri(a, b, c)
        self.tri(a, c, d)
        if with_edges:
            self.edge(a, b)
            self.edge(b, c)
            self.edge(c, d)
            self.edge(d, a)


# ---------------------------------------------------------------------------
# read + classify
# ---------------------------------------------------------------------------


def load_rooms():
    rooms = []
    for path in sorted(RAW.glob("*.mesh")):
        name = path.stem
        floor = room_floor(name)
        mesh = remesh.parse(path.read_bytes())
        verts = []
        tris = []
        for group in mesh.lods[0].groups:
            base = len(verts)
            verts.extend(remesh.positions(mesh, group))
            for a, b, c in remesh.triangles(mesh, group):
                tris.append((a + base, b + base, c + base))
        v = np.asarray(verts, dtype=np.float32)
        f = np.asarray(tris, dtype=np.int64)
        if len(f) == 0:
            continue
        p = v[f]
        inside = np.all(
            (p[:, :, 0] >= X0)
            & (p[:, :, 0] <= X1)
            & (p[:, :, 2] >= Z0)
            & (p[:, :, 2] <= Z1),
            axis=1,
        )
        f = f[inside]
        p = v[f]
        normal = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
        area = np.linalg.norm(normal, axis=1) * 0.5
        ny = normal[:, 1] / (2.0 * area + 1e-12)
        cy = p[:, :, 1].mean(axis=1)
        y_min = p[:, :, 1].min(axis=1)
        y_max = p[:, :, 1].max(axis=1)
        room_top = float(v[:, 1].max())
        up = (
            (ny > 0.6)
            & (area > 0.02)
            & (area < 50.0)
            & (cy >= FLOOR_BASE[floor] - 0.8)
            & (cy < room_top - CEILING_CUT)
        )
        vertical = (
            (np.abs(ny) < 0.4)
            & (area > 0.02)
            & (area < 50.0)
            & (y_min >= FLOOR_BASE[floor] - 0.6)
            & (y_min <= FLOOR_BASE[floor] + 1.6)
            & ((y_max - y_min) >= 1.6)
        )
        slope = (
            (np.abs(ny) > 0.2)
            & (np.abs(ny) < 0.85)
            & (area > 0.05)
            & (area < 25.0)
            & (y_min >= FLOOR_BASE[floor] - 0.4)
            & (y_max <= FLOOR_BASE[floor] + 5.0)
        )
        rooms.append(
            {
                "name": name,
                "floor": floor,
                "up_points": p[up].astype(np.float32),
                "up_y": cy[up].astype(np.float32),
                "wall_points": p[vertical].astype(np.float32),
                "wall_y0": y_min[vertical].astype(np.float32),
                "wall_y1": y_max[vertical].astype(np.float32),
                "slope_points": p[slope].astype(np.float32),
                "slope_y": cy[slope].astype(np.float32),
            }
        )
    return rooms


# ---------------------------------------------------------------------------
# floor plates
# ---------------------------------------------------------------------------


def add_floor_tiles(writer: MeshWriter, mask: np.ndarray, level: float):
    tiles_x = int(math.ceil((X1 - X0) / TILE))
    tiles_z = int(math.ceil((Z1 - Z0) / TILE))
    for tz in range(tiles_z):
        for tx in range(tiles_x):
            cells = 0
            total = 0
            for dz in range(TILE_CELLS):
                for dx in range(TILE_CELLS):
                    ix = tx * TILE_CELLS + dx
                    iz = tz * TILE_CELLS + dz
                    if 0 <= ix < NX and 0 <= iz < NZ:
                        total += 1
                        if mask[iz, ix]:
                            cells += 1
            if total == 0 or cells < max(4, total * 0.45):
                continue
            x0 = X0 + tx * TILE
            x1 = x0 + TILE
            z0 = Z0 + tz * TILE
            z1 = z0 + TILE
            writer.quad(
                (x0, level, z0),
                (x1, level, z0),
                (x1, level, z1),
                (x0, level, z1),
                with_edges=False,
            )


# ---------------------------------------------------------------------------
# walls
# ---------------------------------------------------------------------------


def build_wall_skeleton(rooms, floor: int, level: float, floor_mask: np.ndarray) -> np.ndarray:
    im = grid_mask()
    draw = ImageDraw.Draw(im)
    for room in rooms:
        if room["floor"] != floor:
            continue
        for tri, y0 in zip(room["wall_points"], room["wall_y0"]):
            if abs(y0 - level) > 1.2:
                continue
            pts = [((tri[i, 0] - X0) / CELL, (tri[i, 2] - Z0) / CELL) for i in range(3)]
            best = max(
                ((0, 1), (1, 2), (2, 0)),
                key=lambda e: (pts[e[0]][0] - pts[e[1]][0]) ** 2
                + (pts[e[0]][1] - pts[e[1]][1]) ** 2,
            )
            draw.line([pts[best[0]], pts[best[1]]], fill=1, width=1)
    raw = np.asarray(im, dtype=bool)
    raw = np.asarray(Image.fromarray((raw * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(3))) > 0
    allowed = dilate(floor_mask, 1.5)
    raw &= allowed
    return skeletonize(raw)


def add_skeleton_walls(writer: MeshWriter, skel: np.ndarray, floor: int, level: float):
    y0 = level
    y1 = level + WALL_HEIGHT
    # Horizontal runs (constant z).
    for iz in range(NZ):
        row = skel[iz]
        ix = 0
        while ix < NX:
            if not row[ix]:
                ix += 1
                continue
            start = ix
            while ix < NX and row[ix]:
                ix += 1
            if (ix - start) * CELL < WALL_MIN_LENGTH:
                continue
            x0 = X0 + start * CELL
            x1 = X0 + ix * CELL
            z = Z0 + (iz + 0.5) * CELL
            writer.quad((x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z))
    # Vertical runs (constant x).
    for ix in range(NX):
        col = skel[:, ix]
        iz = 0
        while iz < NZ:
            if not col[iz]:
                iz += 1
                continue
            start = iz
            while iz < NZ and col[iz]:
                iz += 1
            if (iz - start) * CELL < WALL_MIN_LENGTH:
                continue
            z0 = Z0 + start * CELL
            z1 = Z0 + iz * CELL
            x = X0 + (ix + 0.5) * CELL
            writer.quad((x, y0, z0), (x, y0, z1), (x, y1, z1), (x, y1, z0))


def add_stairs(writer: MeshWriter, rooms, floor: int, level: float, floor_mask: np.ndarray):
    slope_mask = grid_mask()
    draw = ImageDraw.Draw(slope_mask)
    for room in rooms:
        if room["floor"] != floor:
            continue
        for tri in room["slope_points"]:
            cy = float(tri[:, 1].mean())
            if cy < level + 0.25 or cy > level + 4.5:
                continue
            draw.polygon(
                [((tri[i, 0] - X0) / CELL, (tri[i, 2] - Z0) / CELL) for i in range(3)],
                fill=1,
            )
    mask = np.asarray(slope_mask, dtype=bool).copy()
    mask &= dilate(floor_mask, 3.0)
    for cells in label_components(mask):
        area = len(cells) * CELL * CELL
        if area < 1.2:
            continue
        zs = [c[0] for c in cells]
        xs = [c[1] for c in cells]
        x0 = X0 + min(xs) * CELL
        x1 = X0 + (max(xs) + 1) * CELL
        z0 = Z0 + min(zs) * CELL
        z1 = Z0 + (max(zs) + 1) * CELL
        dx, dz = x1 - x0, z1 - z0
        if dx < 1.0 or dz < 1.0 or dx * dz > 90.0:
            continue
        long_x = dx >= dz
        run = dx if long_x else dz
        width = dz if long_x else dx
        if run < 1.5 or width < 0.8:
            continue
        ys = []
        for room in rooms:
            if room["floor"] != floor:
                continue
            for tri, cy in zip(room["slope_points"], room["slope_y"]):
                if x0 <= tri[:, 0].mean() <= x1 and z0 <= tri[:, 2].mean() <= z1 and level <= cy <= level + 4.8:
                    ys.append(float(cy))
        if not ys:
            continue
        y0, y1 = min(ys), max(ys)
        if y1 - y0 < 0.9:
            continue
        steps = max(4, min(14, int(round((y1 - y0) / 0.32))))
        # Snap the stair footprint to the short axis centre.
        if long_x:
            zc = (z0 + z1) * 0.5
            half = min(width, 2.2) * 0.5
            za, zb = zc - half, zc + half
            for i in range(steps):
                ya = y1 - (y1 - y0) * i / steps
                yb = y1 - (y1 - y0) * (i + 1) / steps
                xa = x0 + run * i / steps
                xb = x0 + run * (i + 1) / steps
                writer.quad((xa, yb, za), (xb, yb, za), (xb, yb, zb), (xa, yb, zb))
                writer.quad((xa, yb, za), (xa, ya, za), (xa, ya, zb), (xa, yb, zb))
        else:
            xc = (x0 + x1) * 0.5
            half = min(width, 2.2) * 0.5
            xa_, xb_ = xc - half, xc + half
            for i in range(steps):
                ya = y1 - (y1 - y0) * i / steps
                yb = y1 - (y1 - y0) * (i + 1) / steps
                za = z0 + run * i / steps
                zb = z0 + run * (i + 1) / steps
                writer.quad((xa_, yb, za), (xb_, yb, za), (xb_, yb, zb), (xa_, yb, zb))
                writer.quad((xa_, yb, za), (xa_, ya, za), (xa_, ya, zb), (xa_, yb, zb))


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-walls", action="store_true")
    args = parser.parse_args()

    rooms = load_rooms()
    if not rooms:
        sys.exit(f"no meshes in {RAW}; run tools/extract_rpd.py first")

    room_masks = {}
    for floor in (1, 2):
        room_masks[floor] = make_room_masks(rooms, floor, LEVELS[floor])
    upper = union_masks(room_masks[1] + room_masks[2])
    upper = fill_holes(dilate(upper, FOOTPRINT_DILATE_M))
    footprint = upper | main_rect_mask()
    room_masks[0] = make_room_masks(rooms, 0, LEVELS[0], footprint)
    floor_masks = {floor: union_masks(room_masks[floor]) for floor in range(3)}
    floor_masks[0] = filter_components(floor_masks[0] | main_rect_mask(), FLOOR_MIN_AREA)

    writer = MeshWriter()
    stats = []
    for floor, level in enumerate(LEVELS):
        writer.begin_floor(floor)
        add_floor_tiles(writer, floor_masks[floor], level)
        if not args.no_walls:
            skel = build_wall_skeleton(rooms, floor, level, floor_masks[floor])
            add_skeleton_walls(writer, skel, floor, level)
            add_stairs(writer, rooms, floor, level, floor_masks[floor])
        writer.end_floor(floor)
        stats.append(
            {
                "floor": floor + 1,
                "level": level,
                "floor_area": float(floor_masks[floor].sum() * CELL * CELL),
                "triangles": writer.floor_ranges[floor]["tri_count"],
                "edges": writer.floor_ranges[floor]["edge_count"],
            }
        )

    # The renderer only needs positions and the two index buffers.
    bounds_min = [min(writer.positions[i::3]) for i in range(3)]
    bounds_max = [max(writer.positions[i::3]) for i in range(3)]
    OUT_BIN.parent.mkdir(parents=True, exist_ok=True)
    with OUT_BIN.open("wb") as f:
        f.write(b"RPDW")
        f.write(
            struct.pack(
                "<IIIIII",
                2,
                len(writer.positions) // 3,
                len(writer.triangles) // 3,
                len(writer.edges) // 2,
                3,
                0,
            )
        )
        f.write(struct.pack("<3f", *bounds_min))
        f.write(struct.pack("<3f", *bounds_max))
        for floor in range(3):
            r = writer.floor_ranges[floor]
            y_min = LEVELS[floor]
            y_max = LEVELS[floor] + WALL_HEIGHT
            f.write(
                struct.pack(
                    "<IIIIff",
                    r["tri_start"],
                    r["tri_count"],
                    r["edge_start"],
                    r["edge_count"],
                    y_min,
                    y_max,
                )
            )
        writer.positions.tofile(f)
        writer.triangles.tofile(f)
        writer.edges.tofile(f)

    meta = {
        "asset": OUT_BIN.name,
        "version": 2,
        "method": "floor-plan abstraction",
        "levels": list(LEVELS),
        "vertices": len(writer.positions) // 3,
        "triangles": len(writer.triangles) // 3,
        "edges": len(writer.edges) // 2,
        "bytes": OUT_BIN.stat().st_size,
        "bounds": {"min": bounds_min, "max": bounds_max},
        "floors": stats,
        "wall_height": WALL_HEIGHT,
        "tile_size": TILE,
        "filters": {
            "cell": CELL,
            "floor_min_area": FLOOR_MIN_AREA,
            "wall_min_length": WALL_MIN_LENGTH,
            "footprint_dilate_m": FOOTPRINT_DILATE_M,
            "ceiling_cut": CEILING_CUT,
        },
    }
    OUT_JSON.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {OUT_BIN.relative_to(ROOT)}: {meta['vertices']:,} vertices, "
        f"{meta['triangles']:,} triangles, {meta['edges']:,} edges, "
        f"{meta['bytes'] / 1e6:.1f} MB"
    )
    for s in stats:
        print(
            f"  floor {s['floor']} level {s['level']:5.2f}: "
            f"{s['floor_area']:7.1f} m2, {s['triangles']} tris, {s['edges']} edges"
        )


if __name__ == "__main__":
    main()
