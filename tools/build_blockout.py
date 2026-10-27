#!/usr/bin/env python3
"""Build a grey RPD blockout from the real mesh layout.

Walls and floor plates become simple grey boxes at the real floor elevations;
stair flights become triangular ramp prisms. This is a separate scene asset;
the real-geometry asset is untouched.
"""

from __future__ import annotations

import argparse
import array
import json
import math
import pathlib
import re
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from skimage.morphology import skeletonize

import remesh

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "rpd"
OUT_BIN = ROOT / "public" / "rpd" / "blockout.bin"
OUT_JSON = ROOT / "public" / "rpd" / "blockout.json"

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
WALL_MIN_LENGTH = 0.75        # m
Y_SCALE = 1.0
WALL_HEIGHT = 3.2
FLOOR_THICKNESS = 0.28
WALL_THICKNESS = 0.22
PANEL = 1.5
FOOTPRINT_DILATE_M = 1.5
CEILING_CUT = 1.6
HOLE_FILL_AREA = 2.5         # m^2; larger floor holes are stairwells/atria
GREY_FLOOR = (122, 124, 126)
GREY_WALL = (148, 150, 152)
GREY_RAMP = (108, 110, 112)
GREY_WINDOW = (92, 98, 104)


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
        mask = fill_small_holes(mask)
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


def fill_small_holes(mask: np.ndarray, max_area: float = HOLE_FILL_AREA) -> np.ndarray:
    """Fill only small floor gaps; stairwells and atria stay open."""
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
    holes = (~mask) & (~outside)
    out = mask.copy()
    for cells in label_components(holes):
        if len(cells) * CELL * CELL <= max_area:
            for z, x in cells:
                out[z, x] = True
    return out


def rect_mask(x0: float, x1: float, z0: float, z1: float, pad: float = 0.0) -> np.ndarray:
    xs = np.arange(NX) * CELL + X0
    zs = np.arange(NZ) * CELL + Z0
    x = (xs >= x0 - pad) & (xs < x1 + pad)
    z = (zs >= z0 - pad) & (zs < z1 + pad)
    return z[:, None] & x[None, :]


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
    EDGE_STRUCT = 0
    EDGE_GRID = 1

    def __init__(self):
        self.positions = array.array("f")
        self.triangles = array.array("I")
        self.struct_edges = array.array("I")
        self.grid_edges = array.array("I")
        self._verts: dict[tuple[int, int, int], int] = {}
        self._edges: set[tuple[int, int, int]] = set()

    def vert(self, x, y, z, colour=None):
        key = (round(x * 1000), round(y * 1000), round(z * 1000))
        idx = self._verts.get(key)
        if idx is None:
            idx = len(self.positions) // 3
            self._verts[key] = idx
            self.positions.extend((x, y * Y_SCALE, z))
        return idx

    def tri(self, a, b, c):
        self.triangles.extend((a, b, c))

    def edge(self, a, b, kind=EDGE_STRUCT):
        if a == b:
            return
        key = (kind, a, b) if a < b else (kind, b, a)
        if key in self._edges:
            return
        self._edges.add(key)
        (self.struct_edges if kind == self.EDGE_STRUCT else self.grid_edges).extend(key[1:])

    def quad(self, p0, p1, p2, p3, colour=None):
        a = self.vert(*p0)
        b = self.vert(*p1)
        c = self.vert(*p2)
        d = self.vert(*p3)
        self.tri(a, b, c)
        self.tri(a, c, d)

    def plane(self, p0, p1, p2, p3, kind=EDGE_GRID):
        a = self.vert(*p0)
        b = self.vert(*p1)
        c = self.vert(*p2)
        d = self.vert(*p3)
        self.tri(a, b, c)
        self.tri(a, c, d)
        self.edge(a, b, kind); self.edge(b, c, kind)
        self.edge(c, d, kind); self.edge(d, a, kind)

    def box(self, x0, x1, y0, y1, z0, z1, colour=None, kind=EDGE_STRUCT):
        p000 = (x0, y0, z0); p001 = (x0, y0, z1)
        p010 = (x0, y1, z0); p011 = (x0, y1, z1)
        p100 = (x1, y0, z0); p101 = (x1, y0, z1)
        p110 = (x1, y1, z0); p111 = (x1, y1, z1)
        self.quad(p000, p100, p110, p010)
        self.quad(p001, p011, p111, p101)
        self.quad(p000, p001, p101, p100)
        self.quad(p010, p110, p111, p011)
        self.quad(p000, p010, p011, p001)
        self.quad(p100, p101, p111, p110)
        for a, b in (
            (p000, p100), (p100, p110), (p110, p010), (p010, p000),
            (p001, p101), (p101, p111), (p111, p011), (p011, p001),
            (p000, p001), (p100, p101), (p110, p111), (p010, p011),
        ):
            self.edge(self.vert(*a), self.vert(*b), kind)

    def wall_box_h(self, x0, x1, y0, y1, z0, z1):
        n = max(1, int(math.ceil((x1 - x0) / PANEL)))
        w = (x1 - x0) / n
        for i in range(n):
            self.box(x0 + i * w, x0 + (i + 1) * w, y0, y1, z0, z1)
        if y1 - y0 > 2.2:
            ym = y0 + 1.6
            for z in (z0, z1):
                self.edge(self.vert(x0, ym, z), self.vert(x1, ym, z), self.EDGE_STRUCT)

    def wall_box_v(self, z0, z1, y0, y1, x0, x1):
        n = max(1, int(math.ceil((z1 - z0) / PANEL)))
        w = (z1 - z0) / n
        for i in range(n):
            self.box(x0, x1, y0, y1, z0 + i * w, z0 + (i + 1) * w)
        if y1 - y0 > 2.2:
            ym = y0 + 1.6
            for x in (x0, x1):
                self.edge(self.vert(x, ym, z0), self.vert(x, ym, z1), self.EDGE_STRUCT)

    def stair_plane(self, long_x, a_bottom, a_top, b0, b1, y0, y1):
        if long_x:
            p0 = (a_bottom, y0, b0); p1 = (a_bottom, y0, b1)
            p2 = (a_top, y1, b1); p3 = (a_top, y1, b0)
        else:
            p0 = (b0, y0, a_bottom); p1 = (b1, y0, a_bottom)
            p2 = (b1, y1, a_top); p3 = (b0, y1, a_top)
        self.plane(p0, p1, p2, p3, self.EDGE_STRUCT)
        steps = max(2, int(round(abs(y1 - y0) / 0.30)))
        for i in range(1, steps):
            t = i / steps
            y = y0 + (y1 - y0) * t
            a = a_bottom + (a_top - a_bottom) * t
            if long_x:
                u = self.vert(a, y, b0); v = self.vert(a, y, b1)
            else:
                u = self.vert(b0, y, a); v = self.vert(b1, y, a)
            self.edge(u, v, self.EDGE_STRUCT)


class SpecWriter:
    """Collect simplified primitives for the Blender assembly pass."""
    EDGE_STRUCT = 0
    EDGE_GRID = 1

    def __init__(self):
        self.walls = []
        self.floors = []
        self.stairs = []
        self.lines = []
        self.triangles = []

    def tri(self, a, b, c):
        pass

    def vert(self, x, y, z, colour=None):
        return 0

    def edge(self, a, b, kind=EDGE_STRUCT):
        pass

    def _line(self, p, q, kind=EDGE_STRUCT):
        self.lines.append([[float(p[0]), float(p[1]), float(p[2])],
                           [float(q[0]), float(q[1]), float(q[2])], kind])

    def box(self, x0, x1, y0, y1, z0, z1, colour=None, kind=EDGE_STRUCT):
        self.walls.append([x0, x1, y0, y1, z0, z1])

    def wall_box_h(self, x0, x1, y0, y1, z0, z1):
        n = max(1, int(math.ceil((x1 - x0) / PANEL)))
        w = (x1 - x0) / n
        for i in range(n):
            self.box(x0 + i * w, x0 + (i + 1) * w, y0, y1, z0, z1)
        if y1 - y0 > 2.2:
            ym = y0 + 1.6
            for z in (z0, z1):
                self._line((x0, ym, z), (x1, ym, z), self.EDGE_STRUCT)

    def wall_box_v(self, z0, z1, y0, y1, x0, x1):
        n = max(1, int(math.ceil((z1 - z0) / PANEL)))
        w = (z1 - z0) / n
        for i in range(n):
            self.box(x0, x1, y0, y1, z0 + i * w, z0 + (i + 1) * w)
        if y1 - y0 > 2.2:
            ym = y0 + 1.6
            for x in (x0, x1):
                self._line((x, ym, z0), (x, ym, z1), self.EDGE_STRUCT)

    def plane(self, p0, p1, p2, p3, kind=EDGE_GRID):
        self.floors.append([list(p0), list(p1), list(p2), list(p3)])

    def stair_plane(self, long_x, a_bottom, a_top, b0, b1, y0, y1):
        if long_x:
            p0 = (a_bottom, y0, b0); p1 = (a_bottom, y0, b1)
            p2 = (a_top, y1, b1); p3 = (a_top, y1, b0)
        else:
            p0 = (b0, y0, a_bottom); p1 = (b1, y0, a_bottom)
            p2 = (b1, y1, a_top); p3 = (b0, y1, a_top)
        self.stairs.append([list(p0), list(p1), list(p2), list(p3)])
        steps = max(2, int(round(abs(y1 - y0) / 0.30)))
        for i in range(1, steps):
            t = i / steps
            y = y0 + (y1 - y0) * t
            a = a_bottom + (a_top - a_bottom) * t
            if long_x:
                self._line((a, y, b0), (a, y, b1), self.EDGE_STRUCT)
            else:
                self._line((b0, y, a), (b1, y, a), self.EDGE_STRUCT)


# ---------------------------------------------------------------------------
# read + classify
# ---------------------------------------------------------------------------


def submesh_triangles(mesh, group, sub):
    index_size = 4 if mesh.has_32bit_indices else 2
    fmt = "<%dI" if index_size == 4 else "<%dH"
    count = sub.index_count
    raw = struct.unpack_from(fmt % count, mesh.index_buffer, sub.index_start * index_size)
    group_base = remesh.group_vertex_base(group)
    local = sub.vertex_start - group_base
    for i in range(0, count, 3):
        yield raw[i] + local, raw[i + 1] + local, raw[i + 2] + local


def material_names(data: bytes):
    found = [m.group()[:-1].decode("ascii", "ignore") for m in re.finditer(rb"[ -~]{4,}\x00", data)]
    return found


def opening_kind(name: str) -> str | None:
    low = name.lower()
    if "window" in low or "glass" in low:
        return "window"
    if "door" in low and "frame" not in low:
        return "door"
    return None


def opening_mask(rooms, floor: int, kind: str) -> np.ndarray:
    im = grid_mask()
    draw = ImageDraw.Draw(im)
    for room in rooms:
        if room["floor"] != floor:
            continue
        for tri in room["opening_" + kind]:
            draw.polygon(
                [((tri[i, 0] - X0) / CELL, (tri[i, 2] - Z0) / CELL) for i in range(3)],
                fill=1,
            )
    return np.asarray(im, dtype=bool).copy()


def load_rooms():
    rooms = []
    for path in sorted(RAW.glob("*.mesh")):
        name = path.stem
        floor = room_floor(name)
        data = path.read_bytes()
        mesh = remesh.parse(data)
        names = material_names(data)
        verts = []
        tris = []
        doors = []
        windows = []
        stair_tris = []
        arch_walls = []
        wall_exclude = (
            "fence", "railing", "statue", "door", "window", "glass", "stair",
            "ceiling", "floor", "light", "lamp", "sign", "desk", "chair",
            "table", "book", "vent", "pipe", "wire", "curtain", "plant",
            "tree", "car", "debris", "rubble", "trash", "blood", "decal",
            "cloth", "picture", "art",
        )
        for group in mesh.lods[0].groups:
            base = len(verts)
            gpos = remesh.positions(mesh, group)
            verts.extend(gpos)
            for sub in group.submeshes:
                kind = opening_kind(names[sub.material]) if sub.material < len(names) else None
                for a, b, c in submesh_triangles(mesh, group, sub):
                    tri = np.asarray([gpos[a], gpos[b], gpos[c]], dtype=np.float32)
                    tris.append((a + base, b + base, c + base))
                    mname = names[sub.material].lower() if sub.material < len(names) else ""
                    if "stair" in mname and "town" not in mname and "unrain" not in mname:
                        stair_tris.append(tri)
                    if not any(x in mname for x in wall_exclude):
                        normal = np.cross(tri[1] - tri[0], tri[2] - tri[0])
                        area = float(np.linalg.norm(normal)) * 0.5
                        if area > 0.02 and abs(normal[1] / (2.0 * area)) < 0.4 and float(tri[:, 1].max() - tri[:, 1].min()) >= 0.8:
                            arch_walls.append(tri)
                    if kind is None:
                        continue
                    normal = np.cross(tri[1] - tri[0], tri[2] - tri[0])
                    area = float(np.linalg.norm(normal)) * 0.5
                    if area < 1e-5:
                        continue
                    ny = normal[1] / (2.0 * area)
                    if abs(ny) > 0.55:
                        continue
                    ylo = float(tri[:, 1].min())
                    yhi = float(tri[:, 1].max())
                    level = LEVELS[floor]
                    if yhi < level + 0.2 or ylo > level + 2.4:
                        continue
                    if kind == "door":
                        doors.append(tri)
                    elif kind == "window":
                        windows.append(tri)
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
        all_vertical = (
            (np.abs(ny) < 0.4)
            & (area > 0.02)
            & (area < 50.0)
            & ((y_max - y_min) >= 0.8)
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
                "all_wall_points": np.asarray(arch_walls, dtype=np.float32).reshape(-1, 3, 3),
                "wall_y0": y_min[vertical].astype(np.float32),
                "wall_y1": y_max[vertical].astype(np.float32),
                "slope_points": p[slope].astype(np.float32),
                "slope_y": cy[slope].astype(np.float32),
                "opening_door": np.asarray(doors, dtype=np.float32).reshape(-1, 3, 3),
                "opening_window": np.asarray(windows, dtype=np.float32).reshape(-1, 3, 3),
                "stair_points": np.asarray(stair_tris, dtype=np.float32).reshape(-1, 3, 3),
            }
        )
    return rooms


# ---------------------------------------------------------------------------
# floor plates
# ---------------------------------------------------------------------------


def add_floor_tiles(writer: MeshWriter, mask: np.ndarray, level: float, holes: np.ndarray | None = None):
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
            if holes is not None:
                ix0 = tx * TILE_CELLS
                iz0 = tz * TILE_CELLS
                if np.any(holes[iz0 : iz0 + TILE_CELLS, ix0 : ix0 + TILE_CELLS]):
                    continue
            x0 = X0 + tx * TILE
            x1 = x0 + TILE
            z0 = Z0 + tz * TILE
            z1 = z0 + TILE
            writer.plane((x0, level, z0), (x1, level, z0), (x1, level, z1), (x0, level, z1), writer.EDGE_GRID)


# ---------------------------------------------------------------------------
# walls
# ---------------------------------------------------------------------------


def build_wall_bands(rooms, floor: int, level: float, floor_mask: np.ndarray, cut_mask: np.ndarray | None = None):
    """Return the wall skeleton plus low/mid/high wall-coverage rasters.

    A wall band is the projection of any vertical source triangle that crosses
    that height. Sampling the bands along the skeleton separates solid wall,
    doorway (no low/mid wall, lintel above) and window (sill below, gap, lintel
    above).
    """
    band_lo = (0.20, 0.90)
    band_mid = (1.00, 2.00)
    band_hi = (2.20, 3.10)
    images = [grid_mask(), grid_mask(), grid_mask()]
    draws = [ImageDraw.Draw(im) for im in images]
    for room in rooms:
        if room["floor"] != floor:
            continue
        for tri in room["all_wall_points"]:
            y0 = float(tri[:, 1].min()); y1 = float(tri[:, 1].max())
            if y1 < level + 0.15 or y0 > level + WALL_HEIGHT:
                continue
            pts = [((tri[i, 0] - X0) / CELL, (tri[i, 2] - Z0) / CELL) for i in range(3)]
            best = max(
                ((0, 1), (1, 2), (2, 0)),
                key=lambda e: (pts[e[0]][0] - pts[e[1]][0]) ** 2
                + (pts[e[0]][1] - pts[e[1]][1]) ** 2,
            )
            for band, draw in zip((band_lo, band_mid, band_hi), draws):
                if y0 <= level + band[1] and y1 >= level + band[0]:
                    draw.line([pts[best[0]], pts[best[1]]], fill=1, width=1)
    allowed = dilate(floor_mask, 1.5)
    raw = []
    for im in images:
        m = np.asarray(im, dtype=bool).copy()
        m &= allowed
        if cut_mask is not None:
            m &= ~cut_mask
        raw.append(m)
    bands = raw
    union = raw[0] | raw[1] | raw[2]
    return union, bands[0], bands[1], bands[2]


def _band_hit_h(mask: np.ndarray, iz: int, ix: int) -> bool:
    # Tolerate a one-cell row offset without smearing along the wall, which
    # would close narrow doorways.
    for dz in (-1, 0, 1):
        z = iz + dz
        if 0 <= z < NZ and 0 <= ix < NX and mask[z, ix]:
            return True
    return False


def _band_hit_v(mask: np.ndarray, iz: int, ix: int) -> bool:
    for dx in (-1, 0, 1):
        x = ix + dx
        if 0 <= iz < NZ and 0 <= x < NX and mask[iz, x]:
            return True
    return False


def merge_wall_runs(runs):
    """Merge nearly-collinear skeleton runs into long wall lines."""
    runs.sort()
    groups = []
    for run in runs:
        if not groups or run[0] - groups[-1][-1][0] > 0.35:
            groups.append([run])
        else:
            groups[-1].append(run)
    out = []
    for group in groups:
        total = sum(b - a for _c, a, b in group)
        if total <= 0:
            continue
        coord = sum(c * (b - a) for c, a, b in group) / total
        intervals = sorted((a, b) for _c, a, b in group)
        merged = []
        for a, b in intervals:
            if not merged or a > merged[-1][1] + 0.25:
                merged.append([a, b])
            else:
                merged[-1][1] = max(merged[-1][1], b)
        for a, b in merged:
            if b - a >= WALL_MIN_LENGTH:
                out.append((coord, a, b))
    return out


def room_wall_masks(room, level: float):
    images = [grid_mask(), grid_mask(), grid_mask()]
    draws = [ImageDraw.Draw(im) for im in images]
    bands = ((0.20, 0.90), (1.00, 2.00), (2.20, 3.10))
    for tri in room["all_wall_points"]:
        y0 = float(tri[:, 1].min()); y1 = float(tri[:, 1].max())
        if y1 < level + 0.15 or y0 > level + WALL_HEIGHT:
            continue
        pts = [((tri[i, 0] - X0) / CELL, (tri[i, 2] - Z0) / CELL) for i in range(3)]
        best = max(
            ((0, 1), (1, 2), (2, 0)),
            key=lambda e: (pts[e[0]][0] - pts[e[1]][0]) ** 2
            + (pts[e[0]][1] - pts[e[1]][1]) ** 2,
        )
        for band, draw in zip(bands, draws):
            if y0 <= level + band[1] and y1 >= level + band[0]:
                draw.line([pts[best[0]], pts[best[1]]], fill=1, width=1)
    return tuple(np.asarray(im, dtype=bool) for im in images)


def add_global_walls(writer: MeshWriter, floor: int, level: float, wallmask: np.ndarray, low: np.ndarray, mid: np.ndarray, high: np.ndarray):
    y0, y1 = level, level + WALL_HEIGHT

    def emit(a0, a1, fixed, horizontal, lo_m, mi_m, hi_m):
        start = a0; kind0 = None
        for a in range(a0, a1 + 1):
            if a < a1:
                if horizontal:
                    mi = mi_m[fixed, a]; lo = lo_m[fixed, a]; hi = hi_m[fixed, a]
                else:
                    mi = mi_m[a, fixed]; lo = lo_m[a, fixed]; hi = hi_m[a, fixed]
                kind = "solid" if mi else ("window" if lo and hi else ("door" if hi else ("half" if lo else "none")))
            else:
                kind = None
            if kind != kind0:
                if kind0 in ("solid", "window", "door", "half") and a > start:
                    if horizontal:
                        xa = X0 + start * CELL; xb = X0 + a * CELL
                        zc = Z0 + (fixed + 0.5) * CELL
                        za, zb = zc - WALL_THICKNESS * 0.5, zc + WALL_THICKNESS * 0.5
                        if kind0 == "solid": writer.wall_box_h(xa, xb, y0, y1, za, zb)
                        elif kind0 == "window":
                            writer.wall_box_h(xa, xb, y0, level + 0.9, za, zb)
                            writer.wall_box_h(xa, xb, level + 2.1, y1, za, zb)
                        elif kind0 == "door": writer.wall_box_h(xa, xb, level + 2.15, y1, za, zb)
                        elif kind0 == "half": writer.wall_box_h(xa, xb, y0, level + 0.9, za, zb)
                    else:
                        za = Z0 + start * CELL; zb = Z0 + a * CELL
                        xc = X0 + (fixed + 0.5) * CELL
                        xa, xb = xc - WALL_THICKNESS * 0.5, xc + WALL_THICKNESS * 0.5
                        if kind0 == "solid": writer.wall_box_v(za, zb, y0, y1, xa, xb)
                        elif kind0 == "window":
                            writer.wall_box_v(za, zb, y0, level + 0.9, xa, xb)
                            writer.wall_box_v(za, zb, level + 2.1, y1, xa, xb)
                        elif kind0 == "door": writer.wall_box_v(za, zb, level + 2.15, y1, xa, xb)
                        elif kind0 == "half": writer.wall_box_v(za, zb, y0, level + 0.9, xa, xb)
                start = a; kind0 = kind

    for iz in range(NZ):
        a = 0
        while a < NX:
            if not wallmask[iz, a]: a += 1; continue
            b = a
            while b < NX and wallmask[iz, b]: b += 1
            if (b - a) * CELL >= 1.0: emit(a, b, iz, True, low, mid, high)
            a = b
    for ix in range(NX):
        a = 0
        while a < NZ:
            if not wallmask[a, ix]: a += 1; continue
            b = a
            while b < NZ and wallmask[b, ix]: b += 1
            if (b - a) * CELL >= 1.0: emit(a, b, ix, False, low, mid, high)
            a = b


def add_room_walls(writer: MeshWriter, rooms, floor: int, level: float, cut_mask: np.ndarray, floor_mask: np.ndarray):
    y0, y1 = level, level + WALL_HEIGHT

    def emit(a0, a1, fixed, horizontal, low, mid, high):
        start = a0; kind0 = None
        for a in range(a0, a1 + 1):
            if a < a1:
                if horizontal:
                    mi = mid[fixed, a]; lo = low[fixed, a]; hi = high[fixed, a]
                else:
                    mi = mid[a, fixed]; lo = low[a, fixed]; hi = high[a, fixed]
                kind = "solid" if mi else ("window" if lo and hi else ("door" if hi else ("half" if lo else "none")))
            else:
                kind = None
            if kind != kind0:
                if kind0 in ("solid", "window", "door", "half") and a > start:
                    if horizontal:
                        xa = X0 + start * CELL; xb = X0 + a * CELL
                        zc = Z0 + (fixed + 0.5) * CELL
                        lo_y, hi_y = zc - WALL_THICKNESS * 0.5, zc + WALL_THICKNESS * 0.5
                        if kind0 == "solid": writer.wall_box_h(xa, xb, y0, y1, lo_y, hi_y)
                        elif kind0 == "window":
                            writer.wall_box_h(xa, xb, y0, level + 0.9, lo_y, hi_y)
                            writer.wall_box_h(xa, xb, level + 2.1, y1, lo_y, hi_y)
                        elif kind0 == "door": writer.wall_box_h(xa, xb, level + 2.15, y1, lo_y, hi_y)
                        elif kind0 == "half": writer.wall_box_h(xa, xb, y0, level + 0.9, lo_y, hi_y)
                    else:
                        za = Z0 + start * CELL; zb = Z0 + a * CELL
                        xc = X0 + (fixed + 0.5) * CELL
                        lo_x, hi_x = xc - WALL_THICKNESS * 0.5, xc + WALL_THICKNESS * 0.5
                        if kind0 == "solid": writer.wall_box_v(za, zb, y0, y1, lo_x, hi_x)
                        elif kind0 == "window":
                            writer.wall_box_v(za, zb, y0, level + 0.9, lo_x, hi_x)
                            writer.wall_box_v(za, zb, level + 2.1, y1, lo_x, hi_x)
                        elif kind0 == "door": writer.wall_box_v(za, zb, level + 2.15, y1, lo_x, hi_x)
                        elif kind0 == "half": writer.wall_box_v(za, zb, y0, level + 0.9, lo_x, hi_x)
                start = a; kind0 = kind

    for room in rooms:
        if room["floor"] != floor:
            continue
        low, mid, high = room_wall_masks(room, level)
        low = low.copy(); mid = mid.copy(); high = high.copy()
        allowed = floor_mask
        low &= allowed; mid &= allowed; high &= allowed
        if cut_mask is not None:
            low &= ~cut_mask; mid &= ~cut_mask; high &= ~cut_mask
        union = low | mid | high
        for iz in range(NZ):
            a = 0
            while a < NX:
                if not union[iz, a]: a += 1; continue
                b = a
                while b < NX and union[iz, b]: b += 1
                if (b - a) * CELL >= 0.9: emit(a, b, iz, True, low, mid, high)
                a = b
        for ix in range(NX):
            a = 0
            while a < NZ:
                if not union[a, ix]: a += 1; continue
                b = a
                while b < NZ and union[b, ix]: b += 1
                if (b - a) * CELL >= 0.9: emit(a, b, ix, False, low, mid, high)
                a = b


def _mask_hit_xy(mask, tri):
    cx = float(tri[:, 0].mean()); cz = float(tri[:, 2].mean())
    ix = int((cx - X0) / CELL); iz = int((cz - Z0) / CELL)
    return 0 <= ix < NX and 0 <= iz < NZ and bool(mask[iz, ix])


def stair_regions(rooms, level: float, next_level: float, allowed: np.ndarray | None = None):
    out = []
    for room in rooms:
        tris = [t for t in room["stair_points"]
                if float(t[:, 1].max()) >= level - 0.2 and float(t[:, 1].min()) <= next_level + 0.2
                and (allowed is None or _mask_hit_xy(allowed, t))]
        if not tris:
            continue
        p = np.concatenate([t.reshape(-1, 3) for t in tris], axis=0)
        x0, z0 = float(p[:, 0].min()), float(p[:, 2].min())
        x1, z1 = float(p[:, 0].max()), float(p[:, 2].max())
        if x1 - x0 < 1.0 or z1 - z0 < 1.0:
            continue
        out.append({"bbox": (x0, x1, z0, z1), "level": level, "next_level": next_level})
    return out


def flights_from_regions(rooms, regions, level: float, next_level: float):
    allpts = [tri.reshape(-1, 3) for room in rooms for tri in room["stair_points"]]
    flights = []
    for reg in regions:
        x0, x1, z0, z1 = reg["bbox"]
        pts = [p for p in allpts
               if x0 - 0.2 <= p[:, 0].mean() <= x1 + 0.2
               and z0 - 0.2 <= p[:, 2].mean() <= z1 + 0.2
               and p[:, 1].max() >= level - 0.2
               and p[:, 1].min() <= next_level + 0.2]
        ax = az = 0.0
        if pts:
            p = np.concatenate(pts, axis=0)
            A = np.column_stack((p[:, 0], p[:, 2], np.ones(len(p))))
            try:
                ax, az, _ = np.linalg.lstsq(A, p[:, 1], rcond=None)[0]
            except np.linalg.LinAlgError:
                pass
        dx, dz = x1 - x0, z1 - z0
        long_x = abs(ax) * dx >= abs(az) * dz
        if abs(ax) < 1e-4 and abs(az) < 1e-4:
            long_x = dx >= dz
        run = dx if long_x else dz
        width = dz if long_x else dx
        if run < 1.2 or width < 0.8:
            continue
        if long_x:
            top_high = ax >= 0.0
            top = x1 if top_high else x0
            bottom = x0 if top_high else x1
            zc = (z0 + z1) * 0.5
            half = min(width, 3.6) * 0.5
            bbox = (x0, x1, zc - half, zc + half)
        else:
            top_high = az >= 0.0
            top = z1 if top_high else z0
            bottom = z0 if top_high else z1
            xc = (x0 + x1) * 0.5
            half = min(width, 3.6) * 0.5
            bbox = (xc - half, xc + half, z0, z1)
        flights.append({"bbox": bbox, "long_x": long_x, "run": run, "width": min(width, 3.6),
                        "top": top, "bottom": bottom, "level": level, "next_level": next_level})
    return flights


def add_stair_geometry(writer: MeshWriter, rooms, level: float, next_level: float, allowed: np.ndarray | None = None):
    for room in rooms:
        for tri in room["stair_points"]:
            ylo = float(tri[:, 1].min()); yhi = float(tri[:, 1].max())
            if yhi < level - 0.2 or ylo > next_level + 0.2:
                continue
            if allowed is not None and not _mask_hit_xy(allowed, tri):
                continue
            n = np.cross(tri[1] - tri[0], tri[2] - tri[0])
            area = float(np.linalg.norm(n)) * 0.5
            if area < 1e-4 or n[1] / (2.0 * area) < 0.20:
                continue
            a = writer.vert(*tri[0]); b = writer.vert(*tri[1]); c = writer.vert(*tri[2])
            writer.tri(a, b, c)
            writer.edge(a, b, writer.EDGE_STRUCT)
            writer.edge(b, c, writer.EDGE_STRUCT)
            writer.edge(c, a, writer.EDGE_STRUCT)


def add_skeleton_walls(writer: MeshWriter, skel: np.ndarray, low: np.ndarray, mid: np.ndarray, high: np.ndarray, door_mask: np.ndarray, window_mask: np.ndarray, floor: int, level: float):
    y0 = level
    y1 = level + WALL_HEIGHT
    half = WALL_THICKNESS * 0.5
    door_top = level + 2.10
    sill_top = level + 0.90

    hruns = []
    for iz in range(NZ):
        ix = 0
        while ix < NX:
            if not skel[iz, ix]:
                ix += 1
                continue
            start = ix
            while ix < NX and skel[iz, ix]:
                ix += 1
            if (ix - start) * CELL >= WALL_MIN_LENGTH:
                hruns.append((Z0 + (iz + 0.5) * CELL, X0 + start * CELL, X0 + ix * CELL))
    vruns = []
    for ix in range(NX):
        iz = 0
        while iz < NZ:
            if not skel[iz, ix]:
                iz += 1
                continue
            start = iz
            while iz < NZ and skel[iz, ix]:
                iz += 1
            if (iz - start) * CELL >= WALL_MIN_LENGTH:
                vruns.append((X0 + (ix + 0.5) * CELL, Z0 + start * CELL, Z0 + iz * CELL))

    def classify_h(coord, a, b, iz):
        j0 = max(0, int(round((a - X0) / CELL)))
        j1 = min(NX, int(round((b - X0) / CELL)))
        out = []
        for j in range(j0, j1):
            if door_mask[iz, j]:
                kind = "door"
            elif window_mask[iz, j]:
                kind = "window"
            elif _band_hit_h(mid, iz, j):
                kind = "solid"
            elif _band_hit_h(low, iz, j) and _band_hit_h(high, iz, j):
                kind = "window"
            elif _band_hit_h(high, iz, j):
                kind = "door"
            elif _band_hit_h(low, iz, j):
                kind = "half"
            else:
                kind = "none"
            out.append(kind)
        return j0, out

    def classify_v(coord, a, b, ix):
        i0 = max(0, int(round((a - Z0) / CELL)))
        i1 = min(NZ, int(round((b - Z0) / CELL)))
        out = []
        for i in range(i0, i1):
            if door_mask[i, ix]:
                kind = "door"
            elif window_mask[i, ix]:
                kind = "window"
            elif _band_hit_v(mid, i, ix):
                kind = "solid"
            elif _band_hit_v(low, i, ix) and _band_hit_v(high, i, ix):
                kind = "window"
            elif _band_hit_v(high, i, ix):
                kind = "door"
            elif _band_hit_v(low, i, ix):
                kind = "half"
            else:
                kind = "none"
            out.append(kind)
        return i0, out

    def emit_h(coord, j0, j1, kind):
        if kind == "none" or j1 <= j0:
            return
        x0 = X0 + j0 * CELL - half
        x1 = X0 + j1 * CELL + half
        z = coord
        top = sill_top if kind == "half" else y1
        if kind == "solid":
            writer.wall_box_h(x0, x1, y0, y1, z - half, z + half)
        elif kind == "window":
            writer.wall_box_h(x0, x1, y0, sill_top, z - half, z + half)
            writer.wall_box_h(x0, x1, door_top, y1, z - half, z + half)
        elif kind == "door":
            writer.wall_box_h(x0, x1, door_top, y1, z - half, z + half)
        elif kind == "half":
            writer.wall_box_h(x0, x1, y0, sill_top, z - half, z + half)
        size = 0.50 if kind == "solid" else 0.28
        writer.box(x0 - size * 0.5, x0 + size * 0.5, y0, top, z - size * 0.5, z + size * 0.5, GREY_WALL)
        writer.box(x1 - size * 0.5, x1 + size * 0.5, y0, top, z - size * 0.5, z + size * 0.5, GREY_WALL)

    def emit_v(coord, i0, i1, kind):
        if kind == "none" or i1 <= i0:
            return
        z0 = Z0 + i0 * CELL - half
        z1 = Z0 + i1 * CELL + half
        x = coord
        top = sill_top if kind == "half" else y1
        if kind == "solid":
            writer.wall_box_v(z0, z1, y0, y1, x - half, x + half)
        elif kind == "window":
            writer.wall_box_v(z0, z1, y0, sill_top, x - half, x + half)
            writer.wall_box_v(z0, z1, door_top, y1, x - half, x + half)
        elif kind == "door":
            writer.wall_box_v(z0, z1, door_top, y1, x - half, x + half)
        elif kind == "half":
            writer.wall_box_v(z0, z1, y0, sill_top, x - half, x + half)
        size = 0.50 if kind == "solid" else 0.28
        writer.box(x - size * 0.5, x + size * 0.5, y0, top, z0 - size * 0.5, z0 + size * 0.5, GREY_WALL)
        writer.box(x - size * 0.5, x + size * 0.5, y0, top, z1 - size * 0.5, z1 + size * 0.5, GREY_WALL)

    for coord, a, b in merge_wall_runs(hruns):
        iz = max(0, min(NZ - 1, int(round((coord - Z0) / CELL - 0.5))))
        j0, kinds = classify_h(coord, a, b, iz)
        j = 0
        while j < len(kinds):
            k = j
            while k < len(kinds) and kinds[k] == kinds[j]:
                k += 1
            emit_h(coord, j0 + j, j0 + k, kinds[j])
            j = k
    for coord, a, b in merge_wall_runs(vruns):
        ix = max(0, min(NX - 1, int(round((coord - X0) / CELL - 0.5))))
        i0, kinds = classify_v(coord, a, b, ix)
        j = 0
        while j < len(kinds):
            k = j
            while k < len(kinds) and kinds[k] == kinds[j]:
                k += 1
            emit_v(coord, i0 + j, i0 + k, kinds[j])
            j = k


def floor_holes(mask: np.ndarray):
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
    holes = (~mask) & (~outside)
    out = []
    for cells in label_components(holes):
        area = len(cells) * CELL * CELL
        if area < 2.5 or area > 150.0:
            continue
        zs = [c[0] for c in cells]
        xs = [c[1] for c in cells]
        x0 = X0 + min(xs) * CELL
        x1 = X0 + (max(xs) + 1) * CELL
        z0 = Z0 + min(zs) * CELL
        z1 = Z0 + (max(zs) + 1) * CELL
        dx, dz = x1 - x0, z1 - z0
        if dx < 1.2 or dz < 1.2:
            continue
        out.append((area, x0, x1, z0, z1))
    return out


STAIR_SPECS = {
    0: [
        (-18.3, -10.1, -26.4, -14.2),
        (-24.2, -8.2, -6.6, 5.3),
        (14.0, 28.8, -22.7, -7.9),
    ],
    1: [
        (-18.3, -10.1, -26.4, -14.2),
        (21.8, 40.2, -13.3, -1.8),
    ],
}


def stair_flights(rooms, level: float, next_level: float):
    """Place simple flights on the source stairwell footprints."""
    allpts = [tri.reshape(-1, 3) for room in rooms for tri in room["stair_points"]]
    flights = []
    floor = 0 if level < 1.0 else 1
    for x0, x1, z0, z1 in STAIR_SPECS.get(floor, []):
        pts = [p for p in allpts
               if x0 - 0.2 <= p[:, 0].mean() <= x1 + 0.2
               and z0 - 0.2 <= p[:, 2].mean() <= z1 + 0.2
               and p[:, 1].max() >= level - 0.2
               and p[:, 1].min() <= next_level + 0.2]
        if not pts:
            continue
        p = np.concatenate(pts, axis=0)
        y = p[:, 1]
        A = np.column_stack((p[:, 0], p[:, 2], np.ones(len(p))))
        try:
            ax, az, _ = np.linalg.lstsq(A, y, rcond=None)[0]
        except np.linalg.LinAlgError:
            ax = az = 0.0
        dx, dz = x1 - x0, z1 - z0
        long_x = abs(ax) * dx >= abs(az) * dz
        if abs(ax) < 1e-4 and abs(az) < 1e-4:
            long_x = dx >= dz
        run = dx if long_x else dz
        width = dz if long_x else dx
        if run < 2.0 or width < 0.8:
            continue
        if long_x:
            top_high = ax >= 0.0
            top = x1 if top_high else x0
            bottom = x0 if top_high else x1
            zc = (z0 + z1) * 0.5
            half = min(width, 3.6) * 0.5
            bbox = (x0, x1, zc - half, zc + half)
            top_rect = (top - 1.2, top) if top_high else (top, top + 1.2)
            bottom_rect = (bottom - 1.2, bottom) if not top_high else (bottom, bottom + 1.2)
            top_rect = (top_rect[0], top_rect[1], bbox[2], bbox[3])
            bottom_rect = (bottom_rect[0], bottom_rect[1], bbox[2], bbox[3])
        else:
            top_high = az >= 0.0
            top = z1 if top_high else z0
            bottom = z0 if top_high else z1
            xc = (x0 + x1) * 0.5
            half = min(width, 3.6) * 0.5
            bbox = (xc - half, xc + half, z0, z1)
            top_rect = (top - 1.2, top) if top_high else (top, top + 1.2)
            bottom_rect = (bottom - 1.2, bottom) if not top_high else (bottom, bottom + 1.2)
            top_rect = (bbox[0], bbox[1], top_rect[0], top_rect[1])
            bottom_rect = (bbox[0], bbox[1], bottom_rect[0], bottom_rect[1])
        flights.append({
            "bbox": bbox, "long_x": long_x, "run": run, "width": width,
            "top": top, "bottom": bottom, "level": level, "next_level": next_level,
            "top_rect": top_rect, "bottom_rect": bottom_rect,
        })
    return flights


def find_stairs(rooms, floor: int, level: float, floor_mask: np.ndarray):
    """Detect stair flights that climb to the next plate."""
    if floor >= len(LEVELS) - 1:
        return []
    next_level = LEVELS[floor + 1]
    slope_mask = grid_mask()
    draw = ImageDraw.Draw(slope_mask)
    for room in rooms:
        if room["floor"] != floor:
            continue
        for tri in room["slope_points"]:
            cy = float(tri[:, 1].mean())
            if cy < level + 0.2 or cy > next_level + 0.5:
                continue
            draw.polygon(
                [((tri[i, 0] - X0) / CELL, (tri[i, 2] - Z0) / CELL) for i in range(3)],
                fill=1,
            )
    mask = np.asarray(slope_mask, dtype=bool).copy()
    mask &= dilate(floor_mask, 3.0)
    out = []
    for cells in label_components(mask):
        area = len(cells) * CELL * CELL
        if area < 1.0:
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
        pts = []
        for room in rooms:
            if room["floor"] != floor:
                continue
            for tri, cy in zip(room["slope_points"], room["slope_y"]):
                mx = float(tri[:, 0].mean())
                mz = float(tri[:, 2].mean())
                if x0 <= mx <= x1 and z0 <= mz <= z1 and level <= cy <= next_level + 0.6:
                    pts.append((mx, mz, float(cy)))
        if not pts:
            continue
        ymin = min(p[2] for p in pts)
        ymax = max(p[2] for p in pts)
        if ymax < next_level - 1.8 or ymin > level + 1.8:
            continue
        mid = (x0 + x1) * 0.5 if long_x else (z0 + z1) * 0.5
        low = [p[2] for p in pts if (p[0] if long_x else p[1]) < mid]
        high = [p[2] for p in pts if (p[0] if long_x else p[1]) >= mid]
        if not low or not high:
            continue
        top_high = sum(high) / len(high) > sum(low) / len(low)
        top = x1 if long_x and top_high else x0 if long_x else z1 if top_high else z0
        bottom = x0 if long_x and top_high else x1 if long_x else z0 if top_high else z1
        # 1.2 m landing at each end of the flight.
        sign = 1.0 if top > bottom else -1.0
        t0, t1 = (top - 1.2 * sign, top) if sign > 0 else (top, top + 1.2)
        if long_x:
            zc = (z0 + z1) * 0.5
            half = min(width, 2.4) * 0.5
            top_rect = (min(t0, t1), max(t0, t1), zc - half, zc + half)
            bottom_rect = (bottom - 0.7, bottom + 0.7, zc - half, zc + half)
        else:
            xc = (x0 + x1) * 0.5
            half = min(width, 2.4) * 0.5
            top_rect = (xc - half, xc + half, min(t0, t1), max(t0, t1))
            bottom_rect = (xc - half, xc + half, bottom - 0.7, bottom + 0.7)
        out.append(
            {
                "bbox": (x0, x1, z0, z1),
                "long_x": long_x,
                "top_high": top_high,
                "run": run,
                "width": width,
                "top": top,
                "bottom": bottom,
                "level": level,
                "render_level": level * Y_SCALE,
                "next_level": next_level,
                "top_rect": top_rect,
                "bottom_rect": bottom_rect,
            }
        )
    return out


def add_stairs(writer: MeshWriter, stairs, level: float):
    for s in stairs:
        width = min(max(s["width"], 1.0), 2.4)
        if s["long_x"]:
            zc = (s["bbox"][2] + s["bbox"][3]) * 0.5
            writer.stair_plane(
                True, s["bottom"], s["top"],
                zc - width * 0.5, zc + width * 0.5,
                s["level"], s["next_level"],
            )
        else:
            xc = (s["bbox"][0] + s["bbox"][1]) * 0.5
            writer.stair_plane(
                False, s["bottom"], s["top"],
                xc - width * 0.5, xc + width * 0.5,
                s["level"], s["next_level"],
            )


def prune_stairs(flights):
    """Drop near-duplicate flights detected twice in the same stairwell."""
    kept = []
    for s in sorted(flights, key=lambda f: -((f["bbox"][1] - f["bbox"][0]) * (f["bbox"][3] - f["bbox"][2]))):
        x0, x1, z0, z1 = s["bbox"]
        area = (x1 - x0) * (z1 - z0)
        duplicate = False
        for k in kept:
            kx0, kx1, kz0, kz1 = k["bbox"]
            ix = max(0.0, min(x1, kx1) - max(x0, kx0))
            iz = max(0.0, min(z1, kz1) - max(z0, kz0))
            if ix * iz > 0.5 * min(area, (kx1 - kx0) * (kz1 - kz0)):
                duplicate = True
                break
        if not duplicate:
            kept.append(s)
    return kept


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-walls", action="store_true")
    parser.add_argument("--spec", action="store_true")
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

    stairs = {
        floor: stair_regions(rooms, LEVELS[floor], LEVELS[floor + 1])
        for floor in range(2)
    }
    stairs[2] = []
    stairs_flights = {
        floor: flights_from_regions(rooms, stairs[floor], LEVELS[floor], LEVELS[floor + 1])
        for floor in range(2)
    }
    stairs_flights[2] = []
    stairs_flights[0].extend([
        {"bbox": (-7.4, -4.0, -16.0, -8.8), "long_x": False, "run": 7.2, "width": 3.4,
         "top": -8.8, "bottom": -16.0, "level": 0.0, "next_level": 5.0},
        {"bbox": (4.0, 7.4, -16.0, -8.8), "long_x": False, "run": 7.2, "width": 3.4,
         "top": -8.8, "bottom": -16.0, "level": 0.0, "next_level": 5.0},
    ])
    holes = [floor_holes(floor_masks[floor]) for floor in range(3)]
    hole_masks = [np.zeros((NZ, NX), dtype=bool) for _ in range(3)]
    for floor, hs in enumerate(holes):
        for _area, x0, x1, z0, z1 in hs:
            hole_masks[floor] |= rect_mask(x0, x1, z0, z1, pad=0.05)
    openings = [np.zeros((NZ, NX), dtype=bool) for _ in range(3)]
    for floor, flights in stairs.items():
        for s in flights:
            if floor + 1 < 3:
                x0, x1, z0, z1 = s["bbox"]
                openings[floor + 1] |= rect_mask(x0, x1, z0, z1, pad=0.45)
    for floor in range(3):
        floor_masks[floor] &= ~openings[floor]
        floor_masks[floor] = filter_components(floor_masks[floor], FLOOR_MIN_AREA)
        hole_masks[floor] |= openings[floor]
    stair_cut = [np.zeros((NZ, NX), dtype=bool) for _ in range(3)]
    for floor, flights in stairs.items():
        for s in flights:
            x0, x1, z0, z1 = s["bbox"]
            stair_cut[floor] |= rect_mask(x0, x1, z0, z1, pad=0.7)
            if floor + 1 < 3:
                stair_cut[floor + 1] |= rect_mask(x0, x1, z0, z1, pad=0.7)

    writer = SpecWriter() if args.spec else MeshWriter()
    stats = []
    for floor, level in enumerate(LEVELS):
        tri_start = len(writer.triangles) // 3
        add_floor_tiles(writer, floor_masks[floor], level, holes=hole_masks[floor])
        if not args.no_walls:
            wallmask, low, mid, high = build_wall_bands(rooms, floor, level, floor_masks[floor], None)
            wallmask = wallmask & floor_masks[floor]
            low = low & wallmask; mid = mid & wallmask; high = high & wallmask
            add_global_walls(writer, floor, level, wallmask, low, mid, high)
            add_stairs(writer, stairs_flights[floor], level)
        stats.append(
            {
                "floor": floor + 1,
                "level": level,
                "floor_area": float(floor_masks[floor].sum() * CELL * CELL),
                "triangles": len(writer.triangles) // 3 - tri_start,
                "ramps": len(stairs[floor]),
            }
        )

    if args.spec:
        out = {"walls": writer.walls, "floors": writer.floors,
               "stairs": writer.stairs, "lines": writer.lines}
        out_path = ROOT / "build" / "blockout_spec.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(out), encoding="utf-8")
        print(f"wrote {out_path.relative_to(ROOT)}: {len(writer.walls)} walls, "
              f"{len(writer.floors)} floor tiles, {len(writer.stairs)} stairs")
        return
    nv = len(writer.positions) // 3
    nt = len(writer.triangles) // 3
    es = len(writer.struct_edges) // 2
    eg = len(writer.grid_edges) // 2
    if nv == 0 or nt == 0 or es + eg == 0:
        sys.exit("empty blockout")
    pts = np.frombuffer(writer.positions, dtype=np.float32).reshape(-1, 3)
    bounds_min = pts.min(axis=0)
    bounds_max = pts.max(axis=0)
    positions = np.asarray(writer.positions, dtype="<f4")
    triangles = np.asarray(writer.triangles, dtype="<u4")
    struct_edges = np.asarray(writer.struct_edges, dtype="<u4")
    grid_edges = np.asarray(writer.grid_edges, dtype="<u4")

    OUT_BIN.parent.mkdir(parents=True, exist_ok=True)
    with OUT_BIN.open("wb") as f:
        f.write(b"RPDW")
        f.write(struct.pack("<IIIIIII", 4, nv, nt, es, eg, 3, 0))
        f.write(struct.pack("<3f", *bounds_min))
        f.write(struct.pack("<3f", *bounds_max))
        for floor, level in enumerate(LEVELS):
            f.write(struct.pack("<ffff", level, level + WALL_HEIGHT, 0.0, 0.0))
        f.write(positions.tobytes())
        f.write(triangles.tobytes())
        f.write(struct_edges.tobytes())
        f.write(grid_edges.tobytes())

    meta = {
        "asset": OUT_BIN.name,
        "version": 4,
        "method": "wireframe blockout: panel walls, planes, stair lines",
        "vertices": nv,
        "triangles": nt,
        "structural_edges": es,
        "grid_edges": eg,
        "bytes": OUT_BIN.stat().st_size,
        "bounds": {"min": bounds_min.tolist(), "max": bounds_max.tolist()},
        "floors": stats,
        "levels": list(LEVELS),
        "wall_height": WALL_HEIGHT,
        "wall_thickness": WALL_THICKNESS,
        "panel_size": PANEL,
        "tile_size": TILE,
    }
    OUT_JSON.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {OUT_BIN.relative_to(ROOT)}: {nv:,} vertices, {nt:,} triangles, "
        f"{es:,} structural + {eg:,} grid edges, {meta['bytes'] / 1e6:.2f} MB"
    )
    for s in stats:
        print(f"  floor {s['floor']} level {s['level']:5.2f}: {s['triangles']} tris, {s['ramps']} ramps")

if __name__ == "__main__":
    main()
