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
MIN_WALL_LENGTH = 0.9
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


def floor_surfaces(tris, names, floor: int):
    lo, hi = BAND[floor]
    if len(tris) == 0:
        return tris, names
    _, area, ny = tri_geometry(tris)
    y = tris[:, :, 1]
    material_ok = np.array([common.is_floor_material(name) for name in names])
    keep = material_ok & (ny > 0.7) & (area > 0.008)
    keep &= (y.max(axis=1) > lo) & (y.min(axis=1) < hi)
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


def find_levels(tris: np.ndarray, area: np.ndarray, lo: float, hi: float):
    y = tris[:, :, 1].mean(axis=1)
    step = 0.1
    bins = np.arange(lo, hi + step, step)
    hist, edges = np.histogram(y, bins=bins, weights=area)
    total = float(area.sum())
    smooth = np.convolve(hist, np.ones(3) / 3.0, mode="same")
    threshold = max(5.0, total * 0.008)
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
        if merged and abs(p - merged[-1][0]) < 0.4:
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


def build_slabs(tris, area, ymean, levels, floor):
    slabs = []
    assigned = np.zeros(len(tris), dtype=bool)
    for level in levels:
        mask = np.abs(ymean - level) < 0.16
        if mask.sum() == 0:
            continue
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
            if part.area < 3.0:
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


def build_walls(tris, area, ny, ymin, ymax, level, floor, pillar_boxes):
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

    if pillar_boxes:
        centroid = tris.mean(axis=1)
        drop = np.zeros(len(tris), bool)
        for p in pillar_boxes:
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
        grid = np.zeros((nrow, ncol), bool)
        for j in idx:
            tri = tris[j]
            c0 = int((float(tri[:, uaxis].min()) - pl.umin) / cell)
            c1 = int((float(tri[:, uaxis].max()) - pl.umin) / cell)
            r0 = max(0, int((float(tri[:, 1].min()) - pl.base) / cell))
            r1 = min(nrow - 1, int((float(tri[:, 1].max()) - pl.base) / cell))
            grid[r0 : r1 + 1, c0 : c1 + 1] = True
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

    # Pair the two faces of the same wall.
    used = np.zeros(len(planes), bool)
    pairs = []
    for i, a in enumerate(planes):
        if used[i] or not a.runs:
            continue
        best = None
        best_score = 0.0
        for j in range(i + 1, len(planes)):
            b = planes[j]
            if used[j] or b.axis != a.axis or not b.runs:
                continue
            dist = abs(b.plane - a.plane)
            if dist > 0.32:
                continue
            overlap = min(a.u_max, b.u_max) - max(a.umin, b.umin)
            if overlap <= 0.0:
                continue
            score = overlap / max(0.01, min(a.u_max - a.umin, b.u_max - b.umin))
            if score > 0.5 and score > best_score:
                best = j
                best_score = score
        if best is not None:
            pairs.append((i, best))
            used[i] = used[best] = True
    for i, a in enumerate(planes):
        if not used[i]:
            pairs.append((i, None))
            used[i] = True

    walls = []
    for i, j in pairs:
        a = planes[i]
        b = planes[j] if j is not None else None
        thickness = WALL_THICKNESS
        center = a.plane
        if b is not None:
            thickness = max(WALL_THICKNESS, abs(b.plane - a.plane) + 0.05)
            center = (a.plane + b.plane) * 0.5
        for c0, c1, kind in a.runs:
            # Door and window runs are lintels and sills. The blockout keeps
            # the opening, not the detail above or below it.
            if kind in ("door", "window"):
                continue
            u0 = a.umin + c0 * cell
            u1 = a.umin + c1 * cell
            if u1 - u0 < MIN_WALL_LENGTH:
                continue
            if a.top - a.base < MIN_WALL_HEIGHT and kind == "solid":
                continue
            walls.append(
                {
                    "axis": "x" if a.axis == 0 else "z",
                    "plane": round(center, 3),
                    "u0": round(u0, 3),
                    "u1": round(u1, 3),
                    "y0": round(a.base, 3),
                    "y1": round(a.top, 3),
                    "thickness": round(thickness, 3),
                    "kind": kind,
                }
            )
    # Drop exact duplicates produced by overlapping room meshes.
    unique = {}
    for w in walls:
        key = (
            w["axis"], w["plane"], w["u0"], w["u1"], w["y0"], w["y1"], w["kind"],
        )
        unique[key] = w
    return list(unique.values())


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


def _wedge_from_bbox(bbox, points, levels):
    w = bbox["x1"] - bbox["x0"]
    d = bbox["z1"] - bbox["z0"]
    run_x = w >= d
    y0 = float(points[:, 1].min())
    y1 = float(points[:, 1].max())
    y0, y1 = _extend_levels(y0, y1, levels)
    if y1 - y0 < 0.45:
        return None
    if run_x:
        low_end = points[points[:, 0] <= bbox["x0"] + 0.35]
        high_end = points[points[:, 0] >= bbox["x1"] - 0.35]
        axis, high = "x", "max"
    else:
        low_end = points[points[:, 2] <= bbox["z0"] + 0.35]
        high_end = points[points[:, 2] >= bbox["z1"] - 0.35]
        axis, high = "z", "max"
    if len(low_end) and len(high_end):
        if float(high_end[:, 1].mean()) < float(low_end[:, 1].mean()):
            high = "min"
    return {
        "x0": round(bbox["x0"], 2),
        "x1": round(bbox["x1"], 2),
        "z0": round(bbox["z0"], 2),
        "z1": round(bbox["z1"], 2),
        "y0": round(y0, 2),
        "y1": round(y1, 2),
        "axis": axis,
        "high": high,
    }


def detect_tread_stairs(tris, assigned, levels, floor):
    """Find flights as chains of small horizontal treads with rising height."""
    lo, hi = BAND[floor]
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


def detect_ramps(tris, assigned, stairs, floor):
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
        if resid > 0.09 or not (0.05 < slope < 0.5) or rise < 0.1:
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


def detect_stairs_and_ramps(all_tris, all_names, tris, names, assigned, levels, floor):
    lo, hi = BAND[floor]
    stairs = detect_tread_stairs(tris, assigned, levels, floor)

    stair_mat = np.array(
        ["stair" in name.lower() and "town" not in name.lower() for name in all_names]
    )
    if stair_mat.any():
        st = all_tris[stair_mat]
        sy = st[:, :, 1].mean(axis=1)
        st = st[(sy > lo + 0.05) & (sy < hi - 0.05)]
        if len(st):
            for c in raster_components(st, cell=0.12, dilate=0.15):
                w = c["x1"] - c["x0"]
                d = c["z1"] - c["z0"]
                run, width = max(w, d), min(w, d)
                if run < 0.9 or run > 12.0 or width < 0.55 or width > 8.0:
                    continue
                pts = _component_points(st, c)
                if len(pts) < 8:
                    continue
                item = _wedge_from_bbox(c, pts, levels)
                if item is not None:
                    # A long, low strip of stair material is a walkway or a
                    # railing, not a flight.
                    if item["y1"] - item["y0"] < 0.8:
                        continue
                    item["source"] = "stair material"
                    stairs.append(item)

    def dedupe(items):
        kept = []
        for item in sorted(
            items,
            key=lambda s: -((s["x1"] - s["x0"]) * (s["z1"] - s["z0"])),
        ):
            box = (item["x0"], item["x1"], item["z0"], item["z1"])
            area_box = (box[1] - box[0]) * (box[3] - box[2])
            dup = False
            for other in kept:
                ob = (other["x0"], other["x1"], other["z0"], other["z1"])
                ix = max(0.0, min(box[1], ob[1]) - max(box[0], ob[0]))
                iz = max(0.0, min(box[3], ob[3]) - max(box[2], ob[2]))
                if ix * iz > 0.55 * area_box:
                    dup = True
                    break
            if not dup:
                kept.append(item)
        return kept

    named = dedupe([s for s in stairs if s.get("source") == "stair material"])
    precise = [s for s in stairs if s.get("source") != "stair material"]
    precise = dedupe(precise)
    for item in named:
        area_item = (item["x1"] - item["x0"]) * (item["z1"] - item["z0"])
        overlap = False
        for other in precise:
            ix = max(0.0, min(item["x1"], other["x1"]) - max(item["x0"], other["x0"]))
            iz = max(0.0, min(item["z1"], other["z1"]) - max(item["z0"], other["z0"]))
            if ix * iz > 0.25 * area_item:
                overlap = True
                break
        if not overlap:
            precise.append(item)
    stairs = dedupe(precise)
    ramps = dedupe(detect_ramps(tris, assigned, stairs, floor))
    return stairs, ramps


def prune_isolated(spec):
    """Drop detached strips and elements that float outside the floor plates.

    The source meshes include a few exterior ledges and stray wall fragments.
    They are not part of the building blockout. A slab group survives when it
    is the largest on its floor or at least 25 m2. Walls, pillars, stairs and
    ramps survive when their centre is within 2.5 m of a kept plate.
    """
    from shapely.geometry import Point

    for floor in spec["floors"]:
        plates = []
        for i, slab in enumerate(floor["slabs"]):
            try:
                poly = Polygon(slab["rings"][0], slab["rings"][1:])
            except Exception:
                continue
            if poly.area > 0:
                plates.append((i, poly))
        if not plates:
            continue
        groups = []
        used = set()
        for i, poly in plates:
            if i in used:
                continue
            group = [i]
            used.add(i)
            changed = True
            while changed:
                changed = False
                for j, other in plates:
                    if j in used:
                        continue
                    if any(plates[k][1].distance(other) < 1.5 for k in group):
                        group.append(j)
                        used.add(j)
                        changed = True
            groups.append(group)
        largest = max(groups, key=lambda g: sum(plates[i][1].area for i in g))
        keep_ids = set()
        for group in groups:
            area_sum = sum(plates[i][1].area for i in group)
            if group is largest or area_sum >= 25.0:
                keep_ids.update(group)
        kept_slabs = [plates[i] for i in keep_ids]
        floor["slabs"] = [floor["slabs"][i] for i in sorted(keep_ids)]
        if not kept_slabs:
            continue
        plates_union = unary_union([p for _i, p in kept_slabs])
        for key in ("walls", "pillars"):
            kept = []
            for item in floor[key]:
                if key == "walls":
                    if item["axis"] == "x":
                        cx, cz = item["plane"], (item["u0"] + item["u1"]) * 0.5
                    else:
                        cx, cz = (item["u0"] + item["u1"]) * 0.5, item["plane"]
                elif key == "pillars":
                    cx = (item["x0"] + item["x1"]) * 0.5
                    cz = (item["z0"] + item["z1"]) * 0.5
                elif key == "stairs":
                    cx = (item["x0"] + item["x1"]) * 0.5
                    cz = (item["z0"] + item["z1"]) * 0.5
                else:
                    cx = sum(c[0] for c in item["corners"]) / 4.0
                    cz = sum(c[2] for c in item["corners"]) / 4.0
                if plates_union.distance(Point(cx, cz)) <= 2.5:
                    kept.append(item)
            floor[key] = kept


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
    prepared = {}
    for floor in floors:
        lo, hi = BAND[floor]
        all_tris, all_names = common.join(batches, floor)
        tris, names = floor_surfaces(all_tris, all_names, floor)
        vertical, vertical_names = vertical_surfaces(all_tris, all_names, floor)
        _, area, _ny = tri_geometry(tris)
        ymean = tris[:, :, 1].mean(axis=1)
        levels = find_levels(tris, area, lo, hi)
        prepared[floor] = {
            "all_tris": all_tris,
            "all_names": all_names,
            "tris": tris,
            "names": names,
            "vertical": vertical,
            "vertical_names": vertical_names,
            "area": area,
            "ymean": ymean,
            "levels": levels,
        }
    all_levels = sorted({lvl for p in prepared.values() for lvl in p["levels"]})
    for floor in floors:
        lo, hi = BAND[floor]
        level = BASE[floor]
        p = prepared[floor]
        all_tris, all_names = p["all_tris"], p["all_names"]
        tris, names = p["tris"], p["names"]
        vertical, vertical_names = p["vertical"], p["vertical_names"]
        area, ymean, levels = p["area"], p["ymean"], p["levels"]
        _, varea, vny = tri_geometry(vertical)
        vymin = vertical[:, :, 1].min(axis=1)
        vymax = vertical[:, :, 1].max(axis=1)
        slabs, assigned = build_slabs(tris, area, ymean, levels, floor)
        pillars = detect_pillars(vertical, varea, vny, vymin, vymax, floor)
        pillars = merge_pillars(pillars, detect_named_pillars(vertical, vertical_names, floor))
        walls = build_walls(vertical, varea, vny, vymin, vymax, level, floor, pillars)
        stairs, ramps = detect_stairs_and_ramps(all_tris, all_names, tris, names, assigned, all_levels, floor)
        spec["floors"].append(
            {
                "floor": floor,
                "levels": [round(float(x), 3) for x in levels],
                "slabs": slabs,
                "walls": walls,
                "pillars": pillars,
                "stairs": stairs,
                "ramps": ramps,
            }
        )
        print(
            f"floor {floor}: levels {[round(x, 2) for x in levels]}, "
            f"{len(slabs)} slabs, {len(walls)} walls, {len(pillars)} pillars, "
            f"{len(stairs)} stairs, {len(ramps)} ramps"
        )
        if not args.skip_reference:
            ref = write_reference(batches, floor)
            if ref:
                spec["reference"].append({"floor": floor, **ref})
                print(f"  reference {ref['file']}: {ref['triangles']:,} tris, {ref['bytes']/1e6:.1f} MB")

    prune_isolated(spec)
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
