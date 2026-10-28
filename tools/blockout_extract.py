#!/usr/bin/env python3
"""Extract a simple RPD blockout from the decompiled level meshes.

Outputs ``build/blockout/spec.json`` with metre-space primitives and one
reference PLY per floor in Blender orientation. No coordinate is invented:
slabs come from up-facing source triangles, walls from vertical source
triangles, stair wedges from the source stair surfaces.
"""

from __future__ import annotations

import argparse
import json
import math
import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from shapely.geometry import Polygon
from shapely.ops import unary_union

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import blockout_common as common

BUILD = common.BUILD
SPEC = common.SPEC
REFERENCE = common.REFERENCE

BAND = {1: (-1.2, 4.6), 2: (3.9, 9.4), 3: (9.2, 14.8)}
BASE = {1: 0.0, 2: 5.0, 3: 10.25}
SLAB_THICKNESS = 0.25
WALL_THICKNESS = 0.16
MIN_WALL_LENGTH = 0.25
MIN_WALL_HEIGHT = 0.55


def tri_geometry(tris: np.ndarray):
    normal = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    area = np.linalg.norm(normal, axis=1) * 0.5
    ny = normal[:, 1] / np.maximum(2.0 * area, 1e-9)
    return normal, area, ny


def xz_polygon(tri) -> Polygon:
    return Polygon(
        [
            (float(tri[0, 0]), float(tri[0, 2])),
            (float(tri[1, 0]), float(tri[1, 2])),
            (float(tri[2, 0]), float(tri[2, 2])),
        ]
    )


def floor_surfaces(tris, names, floor: int, include_stairs: bool = False):
    lo, hi = BAND[floor]
    if len(tris) == 0:
        return tris, names
    _, area, ny = tri_geometry(tris)
    y = tris[:, :, 1]
    material_ok = np.array(
        [common.is_floor_material(name, include_stairs) for name in names]
    )
    keep = material_ok & (ny > 0.7) & (area > 0.008)
    keep &= (y.max(axis=1) > lo) & (y.min(axis=1) < hi)
    return tris[keep], names[keep]


def floor_surfaces_all(tris, names):
    """Up-facing floor or stair-material triangles, ignoring the height band."""
    if len(tris) == 0:
        return tris, names
    _, area, ny = tri_geometry(tris)
    material_ok = np.array(
        [common.is_floor_material(name, include_stairs=True) for name in names]
    )
    keep = material_ok & (ny > 0.7) & (area > 0.008)
    return tris[keep], names[keep]


def vertical_surfaces(tris, names, floor: int):
    lo, hi = BAND[floor]
    if len(tris) == 0:
        return tris, names
    _, area, ny = tri_geometry(tris)
    y = tris[:, :, 1]
    material_ok = np.array([common.is_wall_material(name) for name in names])
    keep = material_ok & (np.abs(ny) < 0.35) & (area > 0.004)
    keep &= (y.max(axis=1) > lo + 0.1) & (y.min(axis=1) < hi - 0.05)
    return tris[keep], names[keep]


def find_levels(
    tris: np.ndarray,
    area: np.ndarray,
    lo: float,
    hi: float,
    threshold: float = 5.0,
    merge: float = 0.4,
):
    y = tris[:, :, 1].mean(axis=1)
    step = 0.1
    bins = np.arange(lo, hi + step, step)
    hist, edges = np.histogram(y, bins=bins, weights=area)
    total = float(area.sum())
    smooth = np.convolve(hist, np.ones(3) / 3.0, mode="same")
    threshold = max(threshold, total * 0.001)
    peaks: list[tuple[float, float]] = []
    for i in range(1, len(smooth) - 1):
        if (
            smooth[i] >= threshold
            and smooth[i] >= smooth[i - 1]
            and smooth[i] >= smooth[i + 1]
        ):
            peaks.append((float(edges[i] + step / 2), float(smooth[i])))
    peaks.sort()
    merged: list[tuple[float, float]] = []
    for p, weight in peaks:
        if merged and abs(p - merged[-1][0]) < merge:
            level = (merged[-1][0] * merged[-1][1] + p * weight) / (merged[-1][1] + weight)
            merged[-1] = (level, merged[-1][1] + weight)
        else:
            merged.append((p, weight))
    print(
        "  level peaks:",
        ", ".join(f"{p:.2f}({w:.0f})" for p, w in sorted(merged, key=lambda x: -x[1])[:10]),
    )
    return [p for p, _w in merged if lo + 0.1 < p < hi - 0.6]


def fill_small_holes(poly: Polygon, max_area: float = 1.6) -> Polygon:
    holes = []
    for ring in poly.interiors:
        hole = Polygon(ring)
        if hole.area > max_area:
            holes.append(ring.coords)
    return Polygon(poly.exterior, holes)


def build_slabs(tris, area, ymean, levels, floor, min_part: float = 3.0):
    """Union plate triangles into slabs, each assigned to its nearest level.

    Nearest-level assignment leaves no gap between two adjacent levels, which
    a fixed window does around stepped floors such as the main hall.
    """
    slabs = []
    assigned = np.zeros(len(tris), dtype=bool)
    if len(levels) == 0:
        return slabs, assigned
    level_array = np.asarray(levels, dtype=float)
    distance = np.abs(ymean[:, None] - level_array[None, :])
    nearest = distance.argmin(axis=1)
    rows = np.arange(len(ymean))
    for index, level in enumerate(levels):
        mask = (nearest == index) & (distance[rows, index] < 0.35)
        if mask.sum() == 0:
            continue
        level = float(np.average(ymean[mask], weights=area[mask]))
        polys = []
        for tri in tris[mask]:
            try:
                p = xz_polygon(tri)
            except Exception:
                continue
            if p.area > 1e-4:
                polys.append(p)
        if not polys:
            continue
        geom = unary_union(polys).buffer(0.02).simplify(0.03)
        parts = list(geom.geoms) if hasattr(geom, "geoms") else [geom]
        kept = 0
        for part in parts:
            if part.area < min_part:
                continue
            part = fill_small_holes(part)
            rings = [list(part.exterior.coords)] + [list(r.coords) for r in part.interiors]
            slabs.append(
                {
                    "level": round(float(level), 3),
                    "area": round(float(part.area), 2),
                    "rings": [
                        [[round(float(x), 3), round(float(z), 3)] for x, z in ring]
                        for ring in rings
                    ],
                }
            )
            kept += 1
        if kept:
            assigned |= mask
    return slabs, assigned


def stair_free(mask, boxes, cell=0.05, x0=-46.0, z0=-36.0):
    """Clear stair footprints from a plan mask at raster resolution."""
    out = mask.copy()
    for stair in boxes:
        iz0 = max(0, int(round((stair["z0"] - z0) / cell)))
        iz1 = int(round((stair["z1"] - z0) / cell)) + 1
        ix0 = max(0, int(round((stair["x0"] - x0) / cell)))
        ix1 = int(round((stair["x1"] - x0) / cell)) + 1
        out[iz0:iz1, ix0:ix1] = False
    return out


def raster_components(tris, cell=0.12, dilate=0.3):
    """Connected XZ components of triangle footprints."""
    x0, x1 = -46.0, 48.0
    z0, z1 = -36.0, 20.0
    w = int((x1 - x0) / cell) + 1
    h = int((z1 - z0) / cell) + 1
    im = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(im)
    for tri in tris:
        draw.polygon(
            [
                ((float(p[0]) - x0) / cell, (float(p[2]) - z0) / cell)
                for p in tri
            ],
            fill=255,
        )
    size = max(1, int(round(dilate * 2 / cell)) + 1)
    if size % 2 == 0:
        size += 1
    grown = im.filter(ImageFilter.MaxFilter(size))
    mask = np.asarray(grown, dtype=bool).copy()
    seen = np.zeros_like(mask, bool)
    out = []
    for iz in range(h):
        for ix in range(w):
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
                    if 0 <= nz < h and 0 <= nx < w and mask[nz, nx] and not seen[nz, nx]:
                        seen[nz, nx] = True
                        stack.append((nz, nx))
            zz = [c[0] for c in cells]
            xx = [c[1] for c in cells]
            raw = np.asarray(im, dtype=bool)
            bx0, bx1 = min(xx), max(xx) + 1
            bz0, bz1 = min(zz), max(zz) + 1
            filled = raw[bz0:bz1, bx0:bx1]
            out.append(
                {
                    "x0": x0 + bx0 * cell,
                    "x1": x0 + bx1 * cell,
                    "z0": z0 + bz0 * cell,
                    "z1": z0 + bz1 * cell,
                    "area": len(cells) * cell * cell,
                    "fill": float(filled.mean()),
                }
            )
    return out


def detect_pillars(tris, area, ny, ymin, ymax, floor):
    lo, hi = BAND[floor]
    keep = (
        (np.abs(ny) < 0.35)
        & (area > 0.004)
        & (ymax > lo + 0.2)
        & (ymin < hi - 0.1)
    )
    if keep.sum() == 0:
        return []
    comps = raster_components(tris[keep], cell=0.07, dilate=0.10)
    q = tris[keep].reshape(-1, 3)
    pillars = []
    for c in comps:
        w = c["x1"] - c["x0"]
        d = c["z1"] - c["z0"]
        if not (0.22 <= w <= 1.9 and 0.22 <= d <= 1.9):
            continue
        if c["fill"] < 0.18:
            continue
        inside = (
            (q[:, 0] >= c["x0"] - 0.05)
            & (q[:, 0] <= c["x1"] + 0.05)
            & (q[:, 2] >= c["z0"] - 0.05)
            & (q[:, 2] <= c["z1"] + 0.05)
        )
        if inside.sum() < 8:
            continue
        y = q[inside][:, 1]
        height = float(y.max() - y.min())
        if height < 1.5:
            continue
        pillars.append(
            {
                "x0": round(c["x0"], 2),
                "x1": round(c["x1"], 2),
                "z0": round(c["z0"], 2),
                "z1": round(c["z1"], 2),
                "y0": round(float(y.min()), 2),
                "y1": round(float(y.max()), 2),
            }
        )
    return pillars


def detect_named_pillars(vertical, names, floor):
    lo, hi = BAND[floor]
    mask = np.array(
        ["pillar" in name.lower() and "town" not in name.lower() for name in names]
    )
    if not mask.any():
        return []
    tris = vertical[mask]
    if len(tris) == 0:
        return []
    pillars = []
    for c in raster_components(tris, cell=0.08, dilate=0.12):
        w = c["x1"] - c["x0"]
        d = c["z1"] - c["z0"]
        if not (0.2 <= w <= 2.1 and 0.2 <= d <= 2.1):
            continue
        if c["fill"] < 0.04:
            continue
        pts = tris.reshape(-1, 3)
        inside = (
            (pts[:, 0] >= c["x0"] - 0.05)
            & (pts[:, 0] <= c["x1"] + 0.05)
            & (pts[:, 2] >= c["z0"] - 0.05)
            & (pts[:, 2] <= c["z1"] + 0.05)
        )
        q = pts[inside]
        if len(q) < 8:
            continue
        if float(q[:, 1].max() - q[:, 1].min()) < 1.5:
            continue
        pillars.append(
            {
                "x0": round(c["x0"], 2),
                "x1": round(c["x1"], 2),
                "z0": round(c["z0"], 2),
                "z1": round(c["z1"], 2),
                "y0": round(float(q[:, 1].min()), 2),
                "y1": round(float(q[:, 1].max()), 2),
            }
        )
    return pillars


def merge_pillars(a, b):
    out = list(a)
    for p in b:
        dup = False
        for q in out:
            ix = max(0.0, min(p["x1"], q["x1"]) - max(p["x0"], q["x0"]))
            iz = max(0.0, min(p["z1"], q["z1"]) - max(p["z0"], q["z0"]))
            if ix * iz > 0.5 * (p["x1"] - p["x0"]) * (p["z1"] - p["z0"]):
                dup = True
                break
        if not dup:
            out.append(p)
    return out


class Plane:
    def __init__(self, axis, plane):
        self.axis = axis
        self.plane = plane
        self.tris = []
        self.grid = None
        self.umin = 0.0
        self.base = 0.0
        self.top = 0.0
        self.runs = []


def build_walls(tris, area, ny, ymin, ymax, level, floor, exclude_boxes):
    lo, hi = BAND[floor]
    keep = (
        (np.abs(ny) < 0.35)
        & (area > 0.004)
        & (ymax > lo + 0.1)
        & (ymin < hi - 0.05)
    )
    if keep.sum() == 0:
        return []
    tris = tris[keep]
    area = area[keep]
    ny = ny[keep]
    ymin = ymin[keep]
    ymax = ymax[keep]

    if exclude_boxes:
        centroid = tris.mean(axis=1)
        drop = np.zeros(len(tris), bool)
        for p in exclude_boxes:
            drop |= (
                (centroid[:, 0] >= p["x0"] - 0.02)
                & (centroid[:, 0] <= p["x1"] + 0.02)
                & (centroid[:, 2] >= p["z0"] - 0.02)
                & (centroid[:, 2] <= p["z1"] + 0.02)
            )
        tris, area, ny, ymin, ymax = (
            tris[~drop],
            area[~drop],
            ny[~drop],
            ymin[~drop],
            ymax[~drop],
        )

    normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    axis = np.where(np.abs(normals[:, 0]) >= np.abs(normals[:, 2]), 0, 2)
    coord = tris[np.arange(len(tris)), :, axis]
    plane = coord.mean(axis=1)
    order = np.lexsort((plane, axis))
    planes: list[Plane] = []
    for i in order:
        a = int(axis[i])
        p = float(plane[i])
        if planes and planes[-1].axis == a and p - planes[-1].plane <= 0.11:
            planes[-1].tris.append(int(i))
            planes[-1].plane = (planes[-1].plane * (len(planes[-1].tris) - 1) + p) / len(planes[-1].tris)
        else:
            planes.append(Plane(a, p))
            planes[-1].tris.append(int(i))

    cell = 0.03
    for pl in planes:
        idx = np.asarray(pl.tris)
        uaxis = 2 if pl.axis == 0 else 0
        u = tris[idx][:, :, uaxis]
        pl.umin = float(u.min())
        umax = float(u.max())
        if umax - pl.umin < 0.35:
            pl.runs = []
            continue
        y_local = tris[idx][:, :, 1]
        pl.base = float(np.percentile(y_local.min(axis=1), 10))
        pl.base = min(max(pl.base, level - 0.05), level + 1.4)
        pl.top = float(np.percentile(y_local.max(axis=1), 90))
        pl.top = min(max(pl.top, pl.base + 0.4), hi)
        ncol = int(math.ceil((umax - pl.umin) / cell)) + 1
        nrow = int(math.ceil((pl.top - pl.base) / cell)) + 1
        grid_image = Image.new("1", (ncol, nrow), 0)
        grid_draw = ImageDraw.Draw(grid_image)
        for j in idx:
            tri = tris[j]
            points = [
                (
                    (float(point[uaxis]) - pl.umin) / cell,
                    (float(point[1]) - pl.base) / cell,
                )
                for point in tri
            ]
            grid_draw.polygon(points, fill=1)
        grid = np.asarray(grid_image, dtype=bool)
        pl.grid = grid
        low = grid[: max(1, int(0.9 / cell))].any(axis=0)
        mid = grid[int(1.0 / cell) : max(2, int(2.0 / cell))].any(axis=0)
        high = grid[int(2.1 / cell) :].any(axis=0)
        kind = np.where(
            mid,
            "solid",
            np.where(low & high, "window", np.where(low, "half", np.where(high, "door", "none"))),
        )
        runs = []
        start = 0
        for i in range(1, len(kind) + 1):
            if i == len(kind) or kind[i] != kind[start]:
                if kind[start] != "none" and (i - start) * cell >= MIN_WALL_LENGTH:
                    runs.append((start, i, str(kind[start])))
                start = i
        pl.runs = runs
        pl.u_max = umax

    # Keep each wall face as its own thin wall. Pairing the two faces of a
    # wall merges their extents, and the two faces do not always cover the
    # same runs.
    pairs = [(i, None) for i, a in enumerate(planes) if a.runs]

    walls = []
    for i, j in pairs:
        a = planes[i]
        b = planes[j] if j is not None else None
        thickness = WALL_THICKNESS
        center = a.plane
        master = a
        if b is not None:
            thickness = max(WALL_THICKNESS, abs(b.plane - a.plane) + 0.05)
            center = (a.plane + b.plane) * 0.5
            a_cover = sum(run[1] - run[0] for run in a.runs)
            b_cover = sum(run[1] - run[0] for run in b.runs)
            if b_cover > a_cover:
                master = b
        for c0, c1, kind in master.runs:
            u0 = master.umin + c0 * cell
            u1 = master.umin + c1 * cell
            if u1 - u0 < MIN_WALL_LENGTH:
                continue
            sub = master.grid[:, c0:c1]
            occupied = np.where(sub.any(axis=1))[0]
            if len(occupied) == 0:
                continue
            run_top = master.base + (int(occupied.max()) + 1) * cell
            run_top = min(run_top, master.top)
            if run_top - master.base < MIN_WALL_HEIGHT and kind == "solid":
                continue
            bounds = opening_bounds(sub, master.base, cell)
            open_bottom, open_top = (master.base, run_top) if bounds is None else bounds
            if kind in ("door", "window") and (
                open_top - open_bottom < 0.5 or open_top < master.base + 0.8
            ):
                kind = "solid"
                open_bottom = master.base
                open_top = run_top
            walls.append(
                {
                    "axis": "x" if a.axis == 0 else "z",
                    "plane": round(center, 3),
                    "u0": round(u0, 3),
                    "u1": round(u1, 3),
                    "y0": round(master.base, 3),
                    "y1": round(run_top, 3),
                    "thickness": round(thickness, 3),
                    "kind": kind,
                    "open_bottom": round(open_bottom, 3),
                    "open_top": round(open_top, 3),
                }
            )
    # Drop exact duplicates produced by overlapping room meshes.
    unique = {}
    for w in walls:
        key = (
            w["axis"], w["plane"], w["u0"], w["u1"], w["y0"], w["y1"], w["kind"],
            w["open_bottom"], w["open_top"],
        )
        unique[key] = w
    return list(unique.values())


def opening_bounds(sub, base, cell):
    """Median opening bottom/top for a run's occupancy grid."""
    bottoms = []
    tops = []
    for c in range(sub.shape[1]):
        rows = np.where(sub[:, c])[0]
        if len(rows) < 2:
            continue
        if rows[0] > 0:
            bottoms.append(base)
            tops.append(base + rows[0] * cell)
            continue
        gaps = np.where(np.diff(rows) > 1)[0]
        if len(gaps) == 0:
            continue
        gap = gaps[int(np.argmax(np.diff(rows)[gaps]))]
        bottoms.append(base + (rows[gap] + 1) * cell)
        tops.append(base + rows[gap + 1] * cell)
    if not bottoms:
        return None
    return float(np.median(bottoms)), float(np.median(tops))


def fit_plane(points: np.ndarray):
    if len(points) < 4:
        return None
    a = np.column_stack((points[:, 0], points[:, 2], np.ones(len(points))))
    try:
        gx, gz, c = np.linalg.lstsq(a, points[:, 1], rcond=None)[0]
    except np.linalg.LinAlgError:
        return None
    resid = points[:, 1] - (a @ np.array([gx, gz, c]))
    return float(gx), float(gz), float(c), float(np.sqrt(np.mean(resid**2)))


def _component_points(tris, bbox, margin=0.1):
    c = tris.mean(axis=1)
    sel = (
        (c[:, 0] >= bbox["x0"] - margin)
        & (c[:, 0] <= bbox["x1"] + margin)
        & (c[:, 2] >= bbox["z0"] - margin)
        & (c[:, 2] <= bbox["z1"] + margin)
    )
    return c[sel]


def _extend_levels(y0, y1, levels):
    low = [level for level in levels if -0.9 < y0 - level < 0.6]
    high = [level for level in levels if -0.6 < level - y1 < 0.9]
    if low:
        y0 = min(low, key=lambda level: abs(level - y0))
    if high:
        y1 = min(high, key=lambda level: abs(level - y1))
    return y0, y1


def detect_tread_stairs(tris, assigned, levels, lo, hi):
    """Find flights as chains of small horizontal treads with rising height."""
    y = tris[:, :, 1].mean(axis=1)
    _, area, _ = tri_geometry(tris)
    level_gap = np.min(
        np.abs(y[:, None] - np.asarray(levels, dtype=float)[None, :]), axis=1
    )
    short_tread = (area < 1.5) & (level_gap > 0.08)
    idx = np.where(
        ((~assigned) | short_tread)
        & (y > lo + 0.15)
        & (y < hi - 0.15)
        & (area > 0.04)
        & (area < 3.0)
    )[0]
    if len(idx) < 5:
        return []
    tt = tris[idx]
    ty = y[idx]
    cents = tt.mean(axis=1)
    x0 = tt[:, :, 0].min(axis=1)
    x1 = tt[:, :, 0].max(axis=1)
    z0 = tt[:, :, 2].min(axis=1)
    z1 = tt[:, :, 2].max(axis=1)
    n = len(idx)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i in range(n):
        for j in range(i + 1, n):
            dy = abs(float(ty[i] - ty[j]))
            if dy < 0.08 or dy > 0.45:
                continue
            if abs(float(cents[i, 0] - cents[j, 0])) > 1.5:
                continue
            if abs(float(cents[i, 2] - cents[j, 2])) > 1.5:
                continue
            ox = min(float(x1[i]), float(x1[j])) - max(float(x0[i]), float(x0[j]))
            oz = min(float(z1[i]), float(z1[j])) - max(float(z0[i]), float(z0[j]))
            if max(ox, oz) < 0.25:
                continue
            union(i, j)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    stairs = []
    for members in groups.values():
        if len(members) < 5:
            continue
        pts = cents[members]
        fit = fit_plane(pts)
        if fit is None:
            continue
        gx, gz, _intercept, resid = fit
        slope = math.hypot(gx, gz)
        if not (0.15 < slope < 1.6) or resid > 0.45:
            continue
        run_x = abs(gx) >= abs(gz)
        grad = gx if run_x else gz
        cx0, cx1 = float(pts[:, 0].min()), float(pts[:, 0].max())
        cz0, cz1 = float(pts[:, 2].min()), float(pts[:, 2].max())
        if run_x:
            bx0, bx1 = cx0 - 0.2, cx1 + 0.2
            bz0, bz1 = float(z0[members].min()), float(z1[members].max())
        else:
            bz0, bz1 = cz0 - 0.2, cz1 + 0.2
            bx0, bx1 = float(x0[members].min()), float(x1[members].max())
        run, width = (bx1 - bx0, bz1 - bz0) if run_x else (bz1 - bz0, bx1 - bx0)
        if run < 0.6 or width < 0.55 or width > 8.0:
            continue
        high = "max" if grad >= 0 else "min"
        y0, y1 = _extend_levels(
            float(ty[members].min()) - 0.05, float(ty[members].max()) + 0.05, levels
        )
        if y1 - y0 < 0.45:
            continue
        stairs.append(
            {
                "x0": round(bx0, 2),
                "x1": round(bx1, 2),
                "z0": round(bz0, 2),
                "z1": round(bz1, 2),
                "y0": round(y0, 2),
                "y1": round(y1, 2),
                "axis": "x" if run_x else "z",
                "high": high,
                "source": "tread sequence",
            }
        )
    return stairs


def dedupe_flights(items):
    """Keep the largest footprint when two flights cover the same plan area."""
    kept = []
    for item in sorted(
        items, key=lambda s: -((s["x1"] - s["x0"]) * (s["z1"] - s["z0"]))
    ):
        box = (item["x0"], item["x1"], item["z0"], item["z1"])
        area_box = (box[1] - box[0]) * (box[3] - box[2])
        duplicate = False
        for other in kept:
            overlap_x = max(0.0, min(box[1], other["x1"]) - max(box[0], other["x0"]))
            overlap_z = max(0.0, min(box[3], other["z1"]) - max(box[2], other["z0"]))
            if overlap_x * overlap_z > 0.55 * area_box:
                duplicate = True
                break
        if not duplicate:
            kept.append(item)
    return kept


def detect_tread_ramps(tris, assigned, stairs, floor):
    lo, hi = BAND[floor]
    y = tris[:, :, 1].mean(axis=1)
    _, area, ny = tri_geometry(tris)
    candidate = (
        (~assigned)
        & (ny > 0.7)
        & (ny < 0.999)
        & (area > 0.008)
        & (y > lo + 0.05)
        & (y < hi - 0.12)
    )
    if candidate.sum() == 0:
        return []
    ct = tris[candidate]
    in_stair = np.zeros(len(ct), bool)
    cents = ct.mean(axis=1)
    for stair in stairs:
        in_stair |= (
            (cents[:, 0] >= stair["x0"] - 0.2)
            & (cents[:, 0] <= stair["x1"] + 0.2)
            & (cents[:, 2] >= stair["z0"] - 0.2)
            & (cents[:, 2] <= stair["z1"] + 0.2)
        )
    ct = ct[~in_stair]
    if len(ct) == 0:
        return []
    ramps = []
    for c in raster_components(ct, cell=0.15, dilate=0.25):
        if c["area"] < 0.6 or c["area"] > 100.0:
            continue
        w = c["x1"] - c["x0"]
        d = c["z1"] - c["z0"]
        if max(w, d) > 22.0 or min(w, d) < 0.5:
            continue
        pts = _component_points(ct, c, margin=0.05)
        if len(pts) < 10:
            continue
        fit = fit_plane(pts)
        if fit is None:
            continue
        gx, gz, intercept, resid = fit
        slope = math.hypot(gx, gz)
        rise = float(pts[:, 1].max() - pts[:, 1].min())
        if resid > 0.09 or not (0.05 < slope < 0.5):
            continue
        # A short stub is sloped trim, not a ramp that connects two levels.
        if max(w, d) < 2.5:
            continue
        if rise < 0.5:
            continue
        corners = []
        for x, z in (
            (c["x0"], c["z0"]),
            (c["x1"], c["z0"]),
            (c["x1"], c["z1"]),
            (c["x0"], c["z1"]),
        ):
            value = gx * x + gz * z + intercept
            value = min(max(value, float(pts[:, 1].min())), float(pts[:, 1].max()))
            corners.append([round(x, 2), round(float(value), 2), round(z, 2)])
        ramps.append(
            {
                "x0": round(c["x0"], 2),
                "x1": round(c["x1"], 2),
                "z0": round(c["z0"], 2),
                "z1": round(c["z1"], 2),
                "corners": corners,
                "residual": round(resid, 3),
                "source": "sloped surface",
            }
        )
    return ramps


def detect_stair_components(all_tris, all_names):
    """Flights from stair materials, with their full vertical rise.

    The room meshes split one stairwell across several files, so the rise is
    measured on every stair triangle at once and not inside a height band.
    """
    is_stair = np.array(
        ["stair" in str(name).lower() and "town" not in str(name).lower() for name in all_names]
    )
    if not is_stair.any():
        return []
    st = all_tris[is_stair]
    flights = []
    for c in raster_components(st, cell=0.12, dilate=0.15):
        w = c["x1"] - c["x0"]
        d = c["z1"] - c["z0"]
        run, width = max(w, d), min(w, d)
        if run < 0.9 or run > 14.0 or width < 0.55 or width > 8.0:
            continue
        pts = _component_points(st, c)
        if len(pts) < 8:
            continue
        y0 = float(np.percentile(pts[:, 1], 2))
        y1 = float(np.percentile(pts[:, 1], 98))
        if y1 - y0 < 0.8:
            continue
        axis = "x" if w >= d else "z"
        if axis == "x":
            low_end = pts[pts[:, 0] <= c["x0"] + 0.35]
            high_end = pts[pts[:, 0] >= c["x1"] - 0.35]
        else:
            low_end = pts[pts[:, 2] <= c["z0"] + 0.35]
            high_end = pts[pts[:, 2] >= c["z1"] - 0.35]
        high = "max"
        if len(low_end) and len(high_end):
            if float(high_end[:, 1].mean()) < float(low_end[:, 1].mean()):
                high = "min"
        flights.append(
            {
                "x0": round(c["x0"], 2),
                "x1": round(c["x1"], 2),
                "z0": round(c["z0"], 2),
                "z1": round(c["z1"], 2),
                "y0": round(y0, 2),
                "y1": round(y1, 2),
                "axis": axis,
                "high": high,
                "source": "stair component",
            }
        )
    return flights


def partition_flights(flights, storey_levels):
    """Split a multi-storey flight at each storey it passes, snapped to floors."""
    def snap(value):
        near = [level for level in storey_levels if abs(level - value) <= 0.6]
        return min(near, key=lambda level: abs(level - value)) if near else value

    parts = []
    for flight in flights:
        y0, y1 = snap(float(flight["y0"])), snap(float(flight["y1"]))
        if y1 <= y0:
            continue
        cuts = [level for level in storey_levels if y0 + 1.0 < level < y1 - 1.0]
        bounds = [y0] + cuts + [y1]
        for lo, hi in zip(bounds, bounds[1:]):
            if hi - lo < 0.8:
                continue
            item = dict(flight)
            item["y0"] = round(float(lo), 2)
            item["y1"] = round(float(hi), 2)
            parts.append(item)
    return parts


def detect_stairs_and_ramps(tris, assigned, levels, floor, flights):
    ramps = dedupe_flights(detect_tread_ramps(tris, assigned, flights, floor))
    return list(flights), ramps


def add_stair_landings(spec):
    """Give every flight a plate to land on at both ends.

    A switchback turns on a landing that the stair mesh carries, not a floor
    plate, so the blockout needs that landing built from the flight footprint.
    """
    floors = [f["floor"] for f in spec["floors"]]
    levels = sorted(
        {round(float(slab["level"]), 2) for f in spec["floors"] for slab in f["slabs"]}
    )

    def overlap(a, b):
        width = max(0.0, min(a["x1"], b["x1"]) - max(a["x0"], b["x0"]))
        depth = max(0.0, min(a["z1"], b["z1"]) - max(a["z0"], b["z0"]))
        return width * depth

    pending = []
    for floor_spec in spec["floors"]:
        for stair in floor_spec["stairs"]:
            for value in (float(stair["y0"]), float(stair["y1"])):
                if any(abs(value - level) <= 0.35 for level in levels):
                    continue
                pending.append({"y": value, "stairs": [stair]})

    groups = []
    for item in pending:
        for group in groups:
            if abs(group["y"] - item["y"]) <= 0.6 and any(
                overlap(group["stairs"][0], stair) > 0.2 for stair in item["stairs"]
            ):
                count = len(group["stairs"])
                group["y"] = (group["y"] * count + item["y"]) / (count + 1)
                group["stairs"].extend(item["stairs"])
                break
        else:
            groups.append(item)

    for group in groups:
        y = round(float(group["y"]), 2)
        floor = max(f for f in floors if BAND[f][0] <= y)
        target = next(f for f in spec["floors"] if f["floor"] == floor)
        x0 = min(s["x0"] for s in group["stairs"])
        x1 = max(s["x1"] for s in group["stairs"])
        z0 = min(s["z0"] for s in group["stairs"])
        z1 = max(s["z1"] for s in group["stairs"])
        target["slabs"].append(
            {
                "level": y,
                "area": round((x1 - x0) * (z1 - z0), 2),
                "rings": [
                    [
                        [round(x0, 3), round(z0, 3)],
                        [round(x1, 3), round(z0, 3)],
                        [round(x1, 3), round(z1, 3)],
                        [round(x0, 3), round(z1, 3)],
                    ]
                ],
                "mezzanine": True,
            }
        )
        print(f"  landing at {y:.2f} on floor {floor} for {len(group['stairs'])} flights")


def write_reference(batches, floor: int):
    tris, _ = common.join(batches, floor)
    if len(tris) == 0:
        return None
    p = tris.reshape(-1, 3)
    inside = (
        (p[:, 0] > -46.0)
        & (p[:, 0] < 48.0)
        & (p[:, 2] > -36.0)
        & (p[:, 2] < 20.0)
        & (p[:, 1] > -2.0)
        & (p[:, 1] < 22.0)
    ).reshape(-1, 3).all(axis=1)
    t = tris[inside]
    REFERENCE.mkdir(parents=True, exist_ok=True)
    path = REFERENCE / f"rpd_f{floor}.ply"
    # Blender orientation: (x, y, z) source -> (x, -z, y).
    verts = np.empty((len(t) * 3, 3), dtype="<f4")
    verts[:, 0] = t[:, :, 0].reshape(-1)
    verts[:, 1] = -t[:, :, 2].reshape(-1)
    verts[:, 2] = t[:, :, 1].reshape(-1)
    faces = np.arange(len(verts), dtype="<i4").reshape(-1, 3)
    records = np.empty(
        len(faces), dtype=[("count", "u1"), ("index", "<i4", (3,))]
    )
    records["count"] = 3
    records["index"] = faces
    assert records.itemsize == 13
    with path.open("wb") as f:
        f.write(
            f"ply\nformat binary_little_endian 1.0\n"
            f"element vertex {len(verts)}\n"
            f"property float x\nproperty float y\nproperty float z\n"
            f"element face {len(faces)}\n"
            f"property list uchar int vertex_indices\nend_header\n".encode()
        )
        f.write(verts.tobytes())
        f.write(records.tobytes())
    return {"file": path.name, "triangles": int(len(faces)), "bytes": path.stat().st_size}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-reference", action="store_true")
    parser.add_argument("--floors", default="1,2,3")
    args = parser.parse_args()
    floors = [int(x) for x in args.floors.split(",")]
    batches = common.load_rooms()
    total = sum(len(b.tris) for b in batches)
    print(f"loaded {len(batches)} material batches, {total:,} triangles")
    spec = {
        "version": 1,
        "units": "metres",
        "transform": "blender = (x, -z, y)",
        "floors": [],
        "reference": [],
    }
    band_tris, band_names = common.join_band(batches)

    # Floors key by height, so every mesh contributes. The main-hall gallery
    # lives in a floor-1 room mesh and is a floor-2 plate.
    prepared = {}
    for floor in floors:
        lo, hi = BAND[floor]
        plates, _plate_names = floor_surfaces(
            band_tris, band_names, floor, include_stairs=False
        )
        _, parea, pny = tri_geometry(plates)
        flat = pny > 0.97
        plates, parea = plates[flat], parea[flat]
        pymean = plates[:, :, 1].mean(axis=1) if len(plates) else np.zeros(0)
        levels = find_levels(plates, parea, lo, hi, threshold=2.0, merge=0.22)

        # Walls key by room, because one tall wall spans every height band and
        # each room mesh already owns it once.
        room_tris, room_names = common.join(batches, floor)
        vertical, vertical_names = vertical_surfaces(room_tris, room_names, floor)
        prepared[floor] = {
            "plates": plates,
            "parea": parea,
            "pymean": pymean,
            "levels": levels,
            "vertical": vertical,
            "vertical_names": vertical_names,
        }

    slabs_by_floor = {}
    assigned_by_floor = {}
    for floor in floors:
        p = prepared[floor]
        slabs, assigned = build_slabs(
            p["plates"],
            p["parea"],
            p["pymean"],
            p["levels"],
            floor,
            min_part=1.5,
        )
        slabs_by_floor[floor] = slabs
        assigned_by_floor[floor] = assigned

    storey_levels = sorted(
        {
            round(float(slab["level"]), 2)
            for floor in floors
            for slab in slabs_by_floor[floor]
            if sum(
                s["area"]
                for s in slabs_by_floor[floor]
                if abs(float(s["level"]) - float(slab["level"])) < 0.05
            )
            >= 15.0
        }
    )

    # Stairs are 3D objects that cross height bands. Detect every flight once
    # over the whole building, then split it at the storeys it serves.
    surfaces, _surface_names = floor_surfaces_all(band_tris, band_names)
    _, surface_area, _surface_ny = tri_geometry(surfaces)
    surface_y = surfaces[:, :, 1].mean(axis=1)
    assigned = np.zeros(len(surfaces), bool)
    for floor in floors:
        for slab in slabs_by_floor[floor]:
            near = np.abs(surface_y - float(slab["level"])) < 0.2
            if near.any():
                assigned |= near
    flights = detect_tread_stairs(surfaces, assigned, storey_levels, -2.0, 15.0)
    flights += detect_stair_components(band_tris, band_names)
    flights = dedupe_flights(flights)
    flights = [
        flight
        for flight in flights
        if (flight["x1"] - flight["x0"]) * (flight["z1"] - flight["z0"]) >= 0.8
        and flight["y1"] - flight["y0"] >= 0.3
    ]
    flights = partition_flights(flights, storey_levels)

    for floor in floors:
        lo, hi = BAND[floor]
        level = BASE[floor]
        p = prepared[floor]
        vertical, vertical_names = p["vertical"], p["vertical_names"]
        levels = p["levels"]
        _, varea, vny = tri_geometry(vertical)
        vymin = vertical[:, :, 1].min(axis=1)
        vymax = vertical[:, :, 1].max(axis=1)
        stairs = [
            f for f in flights if lo - 0.1 <= f["y0"] <= hi
        ]
        pillars = detect_pillars(vertical, varea, vny, vymin, vymax, floor)
        pillars = merge_pillars(
            pillars, detect_named_pillars(vertical, vertical_names, floor)
        )
        stairs, ramps = detect_stairs_and_ramps(
            p["plates"], assigned_by_floor[floor], levels, floor, stairs
        )
        walls = build_walls(
            vertical,
            varea,
            vny,
            vymin,
            vymax,
            level,
            floor,
            list(pillars) + list(stairs),
        )
        spec["floors"].append(
            {
                "floor": floor,
                "levels": [round(float(x), 3) for x in levels],
                "slabs": slabs_by_floor[floor],
                "walls": walls,
                "pillars": pillars,
                "stairs": stairs,
                "ramps": ramps,
            }
        )
        print(
            f"floor {floor}: levels {[round(x, 2) for x in levels]}, "
            f"{len(slabs_by_floor[floor])} slabs, {len(walls)} walls, "
            f"{len(pillars)} pillars, {len(stairs)} stairs, {len(ramps)} ramps"
        )
        if not args.skip_reference:
            ref = write_reference(batches, floor)
            if ref:
                spec["reference"].append({"floor": floor, **ref})
                print(
                    f"  reference {ref['file']}: {ref['triangles']:,} tris, "
                    f"{ref['bytes']/1e6:.1f} MB"
                )

    add_stair_landings(spec)
    spec["counts"] = {
        "triangles": int(total),
        "slabs": sum(len(f["slabs"]) for f in spec["floors"]),
        "walls": sum(len(f["walls"]) for f in spec["floors"]),
        "pillars": sum(len(f["pillars"]) for f in spec["floors"]),
        "stairs": sum(len(f["stairs"]) for f in spec["floors"]),
        "ramps": sum(len(f["ramps"]) for f in spec["floors"]),
    }
    BUILD.mkdir(parents=True, exist_ok=True)
    SPEC.write_text(json.dumps(spec, indent=1, default=float), encoding="utf-8")
    print(f"wrote {SPEC.relative_to(common.ROOT)}: {spec['counts']}")


if __name__ == "__main__":
    main()
