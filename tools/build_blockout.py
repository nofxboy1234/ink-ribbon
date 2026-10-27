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
WALL_MIN_LENGTH = 1.5        # m
Y_SCALE = 1.0
WALL_HEIGHT = 3.2
FLOOR_THICKNESS = 0.28
WALL_THICKNESS = 0.22
FOOTPRINT_DILATE_M = 1.5
CEILING_CUT = 1.6
HOLE_FILL_AREA = 2.5         # m^2; larger floor holes are stairwells/atria
GREY_FLOOR = (122, 124, 126)
GREY_WALL = (148, 150, 152)
GREY_RAMP = (108, 110, 112)


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
    def __init__(self):
        self.positions = array.array("f")
        self.colors = array.array("B")
        self.triangles = array.array("I")
        self._verts: dict[tuple[int, int, int, int], int] = {}

    def vert(self, x, y, z, colour):
        key = (round(x * 1000), round(y * 1000), round(z * 1000), colour)
        idx = self._verts.get(key)
        if idx is None:
            idx = len(self.positions) // 3
            self._verts[key] = idx
            self.positions.extend((x, y * Y_SCALE, z))
            self.colors.extend(colour)
        return idx

    def tri(self, a, b, c):
        self.triangles.extend((a, b, c))

    def quad(self, p0, p1, p2, p3, colour):
        a = self.vert(*p0, colour)
        b = self.vert(*p1, colour)
        c = self.vert(*p2, colour)
        d = self.vert(*p3, colour)
        self.tri(a, b, c)
        self.tri(a, c, d)

    def box(self, x0, x1, y0, y1, z0, z1, colour):
        # Eight corners, six quads. Winding is irrelevant because the renderer
        # is two-sided and shades from screen-space derivatives.
        p000 = (x0, y0, z0); p001 = (x0, y0, z1)
        p010 = (x0, y1, z0); p011 = (x0, y1, z1)
        p100 = (x1, y0, z0); p101 = (x1, y0, z1)
        p110 = (x1, y1, z0); p111 = (x1, y1, z1)
        self.quad(p000, p100, p110, p010, colour)  # z0
        self.quad(p001, p011, p111, p101, colour)  # z1
        self.quad(p000, p001, p101, p100, colour)  # y0
        self.quad(p010, p110, p111, p011, colour)  # y1
        self.quad(p000, p010, p011, p001, colour)  # x0
        self.quad(p100, p101, p111, p110, colour)  # x1

    def ramp(self, long_x, a_bottom, a_top, b0, b1, y0, y1, colour):
        if abs(a_top - a_bottom) < 1e-5:
            return
        if long_x:
            v0 = (a_bottom, y0, b0); v1 = (a_bottom, y0, b1)
            v2 = (a_top, y0, b0); v3 = (a_top, y0, b1)
            v4 = (a_top, y1, b0); v5 = (a_top, y1, b1)
        else:
            v0 = (b0, y0, a_bottom); v1 = (b1, y0, a_bottom)
            v2 = (b0, y0, a_top); v3 = (b1, y0, a_top)
            v4 = (b0, y1, a_top); v5 = (b1, y1, a_top)
        i0 = self.vert(*v0, colour); i1 = self.vert(*v1, colour)
        i2 = self.vert(*v2, colour); i3 = self.vert(*v3, colour)
        i4 = self.vert(*v4, colour); i5 = self.vert(*v5, colour)
        # base, vertical top face, sloped top, two triangular sides
        self.tri(i0, i1, i3); self.tri(i0, i3, i2)
        self.tri(i2, i3, i5); self.tri(i2, i5, i4)
        self.tri(i0, i1, i5); self.tri(i0, i5, i4)
        self.tri(i0, i2, i4); self.tri(i1, i5, i3)


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
            writer.box(x0, x1, level - FLOOR_THICKNESS, level, z0, z1, GREY_FLOOR)


# ---------------------------------------------------------------------------
# walls
# ---------------------------------------------------------------------------


def build_wall_skeleton(rooms, floor: int, level: float, floor_mask: np.ndarray, cut_mask: np.ndarray | None = None) -> np.ndarray:
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
    if cut_mask is not None:
        raw &= ~cut_mask
    return skeletonize(raw)


def add_skeleton_walls(writer: MeshWriter, skel: np.ndarray, floor: int, level: float):
    y0 = level
    y1 = level + WALL_HEIGHT
    half = WALL_THICKNESS * 0.5
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
            writer.box(x0, x1, y0, y1, z - half, z + half, GREY_WALL)
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
            writer.box(x - half, x + half, y0, y1, z0, z1, GREY_WALL)


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
            writer.ramp(
                True, s["bottom"], s["top"],
                zc - width * 0.5, zc + width * 0.5,
                s["level"], s["next_level"], GREY_RAMP,
            )
        else:
            xc = (s["bbox"][0] + s["bbox"][1]) * 0.5
            writer.ramp(
                False, s["bottom"], s["top"],
                xc - width * 0.5, xc + width * 0.5,
                s["level"], s["next_level"], GREY_RAMP,
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

    stairs = {floor: find_stairs(rooms, floor, LEVELS[floor], floor_masks[floor]) for floor in range(3)}
    manual = (
        (0, -9.5, -5.5, -22.0, -15.0),
        (0, 5.5, 9.5, -22.0, -15.0),
        (1, -31.0, -27.0, 0.0, 6.0),
        (1, -27.0, -23.0, -8.0, -2.0),
    )
    for floor, x0, x1, z0, z1 in manual:
        stairs[floor].append(
            {
                "bbox": (x0, x1, z0, z1),
                "long_x": False,
                "run": z1 - z0,
                "width": x1 - x0,
                "top": z0,
                "bottom": z1,
                "level": LEVELS[floor],
                "next_level": LEVELS[floor + 1],
                "top_rect": (x0, x1, z0, z0 + 1.2),
                "bottom_rect": (x0, x1, z1 - 1.2, z1),
            }
        )
    for floor in range(3):
        stairs[floor] = prune_stairs(stairs[floor])

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

    writer = MeshWriter()
    stats = []
    for floor, level in enumerate(LEVELS):
        tri_start = len(writer.triangles) // 3
        add_floor_tiles(writer, floor_masks[floor], level, holes=hole_masks[floor])
        if not args.no_walls:
            skel = build_wall_skeleton(rooms, floor, level, floor_masks[floor], stair_cut[floor])
            add_skeleton_walls(writer, skel, floor, level)
            add_stairs(writer, stairs[floor], level)
        stats.append(
            {
                "floor": floor + 1,
                "level": level,
                "floor_area": float(floor_masks[floor].sum() * CELL * CELL),
                "triangles": len(writer.triangles) // 3 - tri_start,
                "ramps": len(stairs[floor]),
            }
        )

    nv = len(writer.positions) // 3
    ni = len(writer.triangles)
    if nv == 0 or nv > 65535:
        sys.exit(f"blockout needs 1..65535 vertices, got {nv}")
    pts = np.frombuffer(writer.positions, dtype=np.float32).reshape(-1, 3)
    origin = pts.min(axis=0)
    extent = float((pts.max(axis=0) - origin).max())
    scale = extent / 65535.0 if extent > 1e-6 else 1.0
    q = np.clip(np.rint((pts - origin) / scale), 0, 65535).astype("<u2")
    colours = np.frombuffer(writer.colors, dtype=np.uint8)
    indices = np.frombuffer(writer.triangles, dtype=np.uint32).astype("<u2")
    bounds_min = pts.min(axis=0)
    bounds_max = pts.max(axis=0)

    OUT_BIN.parent.mkdir(parents=True, exist_ok=True)
    with OUT_BIN.open("wb") as f:
        f.write(b"RPDW")
        f.write(struct.pack("<IIIIII", 3, 1, nv, ni // 3, 3, 0))
        f.write(struct.pack("<3f", *bounds_min))
        f.write(struct.pack("<3f", *bounds_max))
        for floor, level in enumerate(LEVELS):
            f.write(struct.pack("<IIff", 0 if floor == 0 else 1, 1 if floor == 0 else 0,
                                level - FLOOR_THICKNESS, level + WALL_HEIGHT))
        f.write(struct.pack("<IIII", nv, ni, 0, 0))
        f.write(struct.pack("<3f", *origin))
        f.write(struct.pack("<f", scale))
        f.write(q.tobytes())
        f.write(colours.tobytes())
        f.write(indices.tobytes())
        while f.tell() % 4:
            f.write(b"\0")

    meta = {
        "asset": OUT_BIN.name,
        "version": 3,
        "method": "grey blockout: boxes for floors/walls, triangular ramps for stairs",
        "vertices": nv,
        "triangles": ni // 3,
        "bytes": OUT_BIN.stat().st_size,
        "bounds": {"min": bounds_min.tolist(), "max": bounds_max.tolist()},
        "floors": stats,
        "levels": list(LEVELS),
        "wall_height": WALL_HEIGHT,
        "floor_thickness": FLOOR_THICKNESS,
        "wall_thickness": WALL_THICKNESS,
        "tile_size": TILE,
        "colours": {"floor": GREY_FLOOR, "wall": GREY_WALL, "ramp": GREY_RAMP},
    }
    OUT_JSON.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {OUT_BIN.relative_to(ROOT)}: {nv:,} vertices, {ni // 3:,} triangles, "
        f"{meta['bytes'] / 1e6:.2f} MB"
    )
    for s in stats:
        print(f"  floor {s['floor']} level {s['level']:5.2f}: {s['triangles']} tris, {s['ramps']} ramps")

if __name__ == "__main__":
    main()
