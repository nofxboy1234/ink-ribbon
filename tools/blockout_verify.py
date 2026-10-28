#!/usr/bin/env python3
"""Compare the blockout spec against the source geometry in plan view.

Writes coverage metrics and colour-coded plan images under
``build/blockout/verify``. A spec that drifts from the source geometry fails
here before it reaches Blender.
"""

from __future__ import annotations

import json
import math
import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import blockout_common as common
import blockout_extract as extract

BUILD = common.BUILD
SPEC = common.SPEC
OUT = BUILD / "verify"

BAND = extract.BAND
X0, X1 = -46.0, 48.0
Z0, Z1 = -36.0, 20.0
CELL = 0.05
W = int((X1 - X0) / CELL) + 1
H = int((Z1 - Z0) / CELL) + 1


def blank():
    return Image.new("L", (W, H), 0)


def draw_floor_polys(draw, polys):
    for poly in polys:
        pts = [((float(x) - X0) / CELL, (float(z) - Z0) / CELL) for x, z in poly]
        draw.polygon(pts, fill=255)


def source_masks(batches, floor, spec_floor):
    lo, hi = BAND[floor]
    tris, names = common.join(batches, floor)
    up_tris, up_names = extract.floor_surfaces(tris, names, floor, include_stairs=True)
    plate_tris, plate_names = extract.floor_surfaces(
        tris, names, floor, include_stairs=False
    )
    stair_boxes = spec_floor.get("stairs", [])
    keep = np.ones(len(plate_tris), dtype=bool)
    if stair_boxes:
        centres = plate_tris.mean(axis=1)
        in_stair = np.zeros(len(plate_tris), dtype=bool)
        for stair in stair_boxes:
            in_stair |= (
                (centres[:, 0] >= stair["x0"] - 0.25)
                & (centres[:, 0] <= stair["x1"] + 0.25)
                & (centres[:, 2] >= stair["z0"] - 0.25)
                & (centres[:, 2] <= stair["z1"] + 0.25)
            )
        keep &= ~in_stair
    plate_tris = plate_tris[keep]
    wall_tris, wall_names = extract.vertical_surfaces(tris, names, floor)
    wall_tris_all = wall_tris
    wall_names_all = wall_names
    if stair_boxes:
        wall_centres = wall_tris.mean(axis=1)
        in_stair = np.zeros(len(wall_tris), dtype=bool)
        for stair in stair_boxes:
            in_stair |= (
                (wall_centres[:, 0] >= stair["x0"] - 0.1)
                & (wall_centres[:, 0] <= stair["x1"] + 0.1)
                & (wall_centres[:, 2] >= stair["z0"] - 0.1)
                & (wall_centres[:, 2] <= stair["z1"] + 0.1)
            )
        wall_tris = wall_tris[~in_stair]
        wall_names = wall_names[~in_stair]
    floor_img = blank()
    fd = ImageDraw.Draw(floor_img)
    for tri in plate_tris:
        fd.polygon(
            [((float(p[0]) - X0) / CELL, (float(p[2]) - Z0) / CELL) for p in tri],
            fill=255,
        )
    width = max(1, int(round(0.10 / CELL)))
    level = extract.BASE[floor]
    y = wall_tris[:, :, 1]
    mid_tris = wall_tris[(y.max(axis=1) > level + 1.0) & (y.min(axis=1) < level + 2.0)]
    low_tris = wall_tris[(y.max(axis=1) > level + 0.25) & (y.min(axis=1) < level + 0.9)]

    def draw_walls(chosen):
        img = blank()
        draw = ImageDraw.Draw(img)
        for tri in chosen:
            pts = [((float(p[0]) - X0) / CELL, (float(p[2]) - Z0) / CELL) for p in tri]
            edges = [
                (pts[0], pts[1], math.dist(pts[0], pts[1])),
                (pts[1], pts[2], math.dist(pts[1], pts[2])),
                (pts[2], pts[0], math.dist(pts[2], pts[0])),
            ]
            a, b, _ = max(edges, key=lambda e: e[2])
            draw.line([a, b], fill=255, width=width)
        return img

    return (
        floor_img,
        draw_walls(mid_tris),
        draw_walls(low_tris),
        draw_walls(wall_tris),
        plate_tris,
        up_tris,
        wall_tris_all,
        wall_names_all,
    )


def spec_masks(spec_floor):
    floor_arr = np.zeros((H, W), dtype=bool)
    for slab in spec_floor["slabs"]:
        layer = blank()
        fd = ImageDraw.Draw(layer)
        rings = slab["rings"]
        outer = [((float(x) - X0) / CELL, (float(z) - Z0) / CELL) for x, z in rings[0]]
        fd.polygon(outer, fill=255)
        for hole in rings[1:]:
            fd.polygon(
                [((float(x) - X0) / CELL, (float(z) - Z0) / CELL) for x, z in hole],
                fill=0,
            )
        floor_arr |= np.asarray(layer, dtype=bool)
    floor_img = Image.fromarray((floor_arr * 255).astype(np.uint8))
    solid = blank()
    half = blank()
    footprint = blank()
    sd = ImageDraw.Draw(solid)
    hd = ImageDraw.Draw(half)
    fp = ImageDraw.Draw(footprint)
    for wall in spec_floor["walls"]:
        t = wall["thickness"] * 0.5
        if wall["axis"] == "x":
            x0, x1 = wall["plane"] - t, wall["plane"] + t
            z0, z1 = wall["u0"], wall["u1"]
        else:
            z0, z1 = wall["plane"] - t, wall["plane"] + t
            x0, x1 = wall["u0"], wall["u1"]
        rect = [
            ((x0 - X0) / CELL, (z0 - Z0) / CELL),
            ((x1 - X0) / CELL, (z1 - Z0) / CELL),
        ]
        fp.rectangle(rect, fill=255)
        if wall["kind"] == "solid":
            sd.rectangle(rect, fill=255)
        elif wall["kind"] == "half":
            hd.rectangle(rect, fill=255)
    return floor_img, solid, half, footprint


def mask_array(img):
    return np.asarray(img, dtype=bool)


def dilate(mask, metres):
    px = max(1, int(round(metres / CELL)) * 2 + 1)
    im = Image.fromarray(mask.astype(np.uint8) * 255)
    return np.asarray(im.filter(ImageFilter.MaxFilter(px))) > 0


def score(source, spec, tolerance):
    s = mask_array(source)
    b = mask_array(spec)
    if not s.any() or not b.any():
        return {"precision": 0.0, "recall": 0.0, "source_m2": 0.0, "spec_m2": 0.0}
    inside_source = (b & dilate(s, tolerance)).sum() / b.sum()
    covered = (s & dilate(b, tolerance)).sum() / s.sum()
    return {
        "precision": round(float(inside_source), 3),
        "recall": round(float(covered), 3),
        "source_m2": round(float(s.sum()) * CELL * CELL, 1),
        "spec_m2": round(float(b.sum()) * CELL * CELL, 1),
    }


def composite(source_floor, source_wall, spec_floor, spec_wall, spec_floor_data):
    base = Image.new("RGB", (W, H), (14, 15, 17))
    sf = np.asarray(source_floor, dtype=bool)
    sw = np.asarray(source_wall, dtype=bool)
    base_arr = np.asarray(base).copy()
    base_arr[sf] = (42, 62, 92)
    base_arr[sw] = (110, 112, 116)
    base = Image.fromarray(base_arr)
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    bf = np.asarray(spec_floor, dtype=bool)
    od.bitmap((0, 0), Image.fromarray((bf * 120).astype(np.uint8)), fill=(70, 210, 120, 100))
    for slab in spec_floor_data:
        for ring in slab["rings"]:
            pts = [((float(x) - X0) / CELL, (float(z) - Z0) / CELL) for x, z in ring]
            od.line(pts, fill=(70, 230, 130, 200), width=2)
    base = Image.alpha_composite(base.convert("RGBA"), overlay)
    od = ImageDraw.Draw(base)
    bw = np.asarray(spec_wall, dtype=bool)
    wall_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    wd = ImageDraw.Draw(wall_layer)
    wd.bitmap((0, 0), Image.fromarray((bw * 200).astype(np.uint8)), fill=(255, 120, 40, 220))
    base = Image.alpha_composite(base, wall_layer)
    for gx in range(-40, 49, 10):
        base_draw = ImageDraw.Draw(base)
        base_draw.line([((gx - X0) / CELL, 0), ((gx - X0) / CELL, H)], fill=(30, 31, 34, 255))
    for gz in range(-30, 21, 10):
        base_draw = ImageDraw.Draw(base)
        base_draw.line([(0, (gz - Z0) / CELL), (W, (gz - Z0) / CELL)], fill=(30, 31, 34, 255))
    return base.convert("RGB")


def simple_levels(ft, lo, hi):
    """Independent floor-level estimate from a plain area histogram."""
    y = ft[:, :, 1].mean(axis=1)
    area = extract.tri_geometry(ft)[1]
    step = 0.05
    bins = np.arange(lo, hi + step, step)
    hist, edges = np.histogram(y, bins=bins, weights=area)
    top = np.argsort(hist)[-10:]
    candidates = sorted(
        (float(edges[i] + step / 2), float(hist[i])) for i in top if hist[i] >= 5.0
    )
    merged = []
    for level, weight in candidates:
        if merged and abs(level - merged[-1][0]) < 0.2:
            old_level, old_weight = merged[-1]
            merged[-1] = (
                (old_level * old_weight + level * weight) / (old_weight + weight),
                old_weight + weight,
            )
        else:
            merged.append((level, weight))
    return [round(level, 2) for level, _weight in merged]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    batches = common.load_rooms()
    report = []
    for spec_floor in spec["floors"]:
        floor = spec_floor["floor"]
        (
            source_floor,
            source_mid,
            source_low,
            source_all_walls,
            _plate,
            _ft,
            _wt,
            _wn,
        ) = source_masks(batches, floor, spec_floor)
        spec_floor_img, spec_solid, spec_half, spec_footprint = spec_masks(spec_floor)
        fs = score(source_floor, spec_floor_img, 0.08)
        ws = score(source_mid, spec_solid, 0.2)
        hs = score(source_low, spec_half, 0.2)
        fp = score(source_all_walls, spec_footprint, 0.2)
        # Scale check: every source tread centroid must sit inside the stair
        # footprint, and the wedge must span the source rise.
        centres = _ft.mean(axis=1)
        tread_area = extract.tri_geometry(_ft)[1]
        stair_checks = []
        for stair in spec_floor["stairs"]:
            inside = (
                (centres[:, 0] >= stair["x0"] - 0.25)
                & (centres[:, 0] <= stair["x1"] + 0.25)
                & (centres[:, 2] >= stair["z0"] - 0.25)
                & (centres[:, 2] <= stair["z1"] + 0.25)
                & (tread_area < 1.0)
                & (tread_area > 0.03)
            )
            selected = _ft[inside]
            source_lo = float(selected[:, :, 1].min()) if len(selected) else 0.0
            source_hi = float(selected[:, :, 1].max()) if len(selected) else 0.0
            covered = (
                (selected[:, :, 1].mean(axis=1) >= stair["y0"] - 0.3)
                & (selected[:, :, 1].mean(axis=1) <= stair["y1"] + 0.3)
            )
            coverage = float(covered.mean()) if len(selected) else 0.0
            stair_checks.append(
                {
                    "bbox": [stair["x0"], stair["x1"], stair["z0"], stair["z1"]],
                    "source_treads": int(len(selected)),
                    "source_y": [round(source_lo, 2), round(source_hi, 2)],
                    "spec_y": [stair["y0"], stair["y1"]],
                    "tread_coverage": round(coverage, 3),
                }
            )
        pillar_centres = _wt.mean(axis=1) if len(_wt) else np.zeros((0, 3))
        pillars_supported = 0
        for pillar in spec_floor["pillars"]:
            inside = (
                (pillar_centres[:, 0] >= pillar["x0"] - 0.1)
                & (pillar_centres[:, 0] <= pillar["x1"] + 0.1)
                & (pillar_centres[:, 2] >= pillar["z0"] - 0.1)
                & (pillar_centres[:, 2] <= pillar["z1"] + 0.1)
                & (pillar_centres[:, 1] >= pillar["y0"] - 0.3)
                & (pillar_centres[:, 1] <= pillar["y1"] + 0.3)
            )
            if inside.any():
                pillars_supported += 1

        floor_normal = extract.tri_geometry(_ft)[2]
        sloped = _ft[(floor_normal > 0.7) & (floor_normal < 0.999)]
        sloped_centres = sloped.mean(axis=1) if len(sloped) else np.zeros((0, 3))
        ramps_supported = 0
        for ramp in spec_floor["ramps"]:
            ys = [corner[1] for corner in ramp["corners"]]
            inside = (
                (sloped_centres[:, 0] >= ramp["x0"] - 0.2)
                & (sloped_centres[:, 0] <= ramp["x1"] + 0.2)
                & (sloped_centres[:, 2] >= ramp["z0"] - 0.2)
                & (sloped_centres[:, 2] <= ramp["z1"] + 0.2)
                & (sloped_centres[:, 1] >= min(ys) - 0.4)
                & (sloped_centres[:, 1] <= max(ys) + 0.4)
            )
            if inside.any():
                ramps_supported += 1

        structural = np.concatenate([_ft, _wt]) if len(_wt) else _ft
        p = structural.reshape(-1, 3)
        spec_points = []
        for slab in spec_floor["slabs"]:
            for ring in slab["rings"]:
                spec_points.extend([[x, slab["level"], z] for x, z in ring])
        for wall in spec_floor["walls"]:
            for y in (wall["y0"], wall["y1"]):
                if wall["axis"] == "x":
                    spec_points.extend([[wall["plane"], y, wall["u0"]], [wall["plane"], y, wall["u1"]]])
                else:
                    spec_points.extend([[wall["u0"], y, wall["plane"]], [wall["u1"], y, wall["plane"]]])
        for stair in spec_floor["stairs"]:
            spec_points.extend(
                [[stair["x0"], stair["y0"], stair["z0"]], [stair["x1"], stair["y1"], stair["z1"]]]
            )
        for pillar in spec_floor["pillars"]:
            for x in (pillar["x0"], pillar["x1"]):
                for y in (pillar["y0"], pillar["y1"]):
                    for z in (pillar["z0"], pillar["z1"]):
                        spec_points.append([x, y, z])
        for ramp in spec_floor["ramps"]:
            for x, y, z in ramp["corners"]:
                spec_points.append([x, y, z])
                spec_points.append([x, y - 0.22, z])
        sp = np.asarray(spec_points, dtype=float)
        spec_levels = sorted(
            {
                round(float(slab["level"]), 2)
                for slab in spec_floor["slabs"]
                if not slab.get("mezzanine")
            }
        )
        source_levels = simple_levels(_plate, *BAND[floor])
        levels_match = all(
            any(abs(level - source) < 0.2 for source in source_levels)
            for level in spec_levels
        )
        bounds_margin = {
            "min": [round(float(v), 2) for v in (sp.min(axis=0) - p.min(axis=0))],
            "max": [round(float(v), 2) for v in (p.max(axis=0) - sp.max(axis=0))],
        }
        bounds_within_0_5m = bool(
            all(value >= -0.5 for value in bounds_margin["min"])
            and all(value >= -0.5 for value in bounds_margin["max"])
        )
        record = {
            "floor": floor,
            "floor_score": fs,
            "spec_levels": spec_levels,
            "source_levels": source_levels,
            "levels_match": levels_match,
            "bounds_within_0_5m": bounds_within_0_5m,
            "bounds_margin": bounds_margin,
            "pillars_supported": pillars_supported,
            "ramps_supported": ramps_supported,
            "solid_wall": ws,
            "half_wall": hs,
            "wall_footprint": fp,
            "slabs": len(spec_floor["slabs"]),
            "walls": len(spec_floor["walls"]),
            "stairs": len(spec_floor["stairs"]),
            "ramps": len(spec_floor["ramps"]),
            "pillars": len(spec_floor["pillars"]),
            "source_bounds": {
                "min": [round(float(v), 2) for v in p.min(axis=0)],
                "max": [round(float(v), 2) for v in p.max(axis=0)],
            },
            "spec_bounds": {
                "min": [round(float(v), 2) for v in sp.min(axis=0)],
                "max": [round(float(v), 2) for v in sp.max(axis=0)],
            },
            "stair_checks": stair_checks,
        }
        report.append(record)
        all_spec = Image.fromarray(
            (np.asarray(spec_solid, bool) | np.asarray(spec_half, bool)).astype(np.uint8) * 255
        )
        all_source = Image.fromarray(
            (np.asarray(source_mid, bool) | np.asarray(source_low, bool)).astype(np.uint8) * 255
        )
        img = composite(
            source_floor, all_source, spec_floor_img, all_spec, spec_floor["slabs"]
        )
        marks = ImageDraw.Draw(img)
        for stair in spec_floor["stairs"]:
            marks.rectangle(
                [
                    ((stair["x0"] - X0) / CELL, (stair["z0"] - Z0) / CELL),
                    ((stair["x1"] - X0) / CELL, (stair["z1"] - Z0) / CELL),
                ],
                outline=(60, 220, 90),
                width=3,
            )
        for ramp in spec_floor["ramps"]:
            marks.rectangle(
                [
                    ((ramp["x0"] - X0) / CELL, (ramp["z0"] - Z0) / CELL),
                    ((ramp["x1"] - X0) / CELL, (ramp["z1"] - Z0) / CELL),
                ],
                outline=(220, 100, 220),
                width=3,
            )
        img.save(OUT / f"plan_f{floor}.png")
        print(
            f"floor {floor}: floor precision {fs['precision']:.3f} "
            f"recall {fs['recall']:.3f} | solid wall precision {ws['precision']:.3f} "
            f"recall {ws['recall']:.3f} | wall footprint precision "
            f"{fp['precision']:.3f} recall {fp['recall']:.3f}"
        )
    failures = []
    for f in report:
        if f["floor_score"]["recall"] < 0.99:
            failures.append(f"floor {f['floor']} floor recall below 0.99")
        if f["solid_wall"]["precision"] < 0.85:
            failures.append(f"floor {f['floor']} solid wall precision below 0.85")
        if f["solid_wall"]["recall"] < 0.90:
            failures.append(f"floor {f['floor']} solid wall recall below 0.90")
        if f["wall_footprint"]["precision"] < 0.95:
            failures.append(f"floor {f['floor']} wall footprint precision below 0.95")
        if f["wall_footprint"]["recall"] < 0.95:
            failures.append(f"floor {f['floor']} wall footprint recall below 0.95")
        if not f["levels_match"]:
            failures.append(f"floor {f['floor']} floor level mismatch")
        if not f["bounds_within_0_5m"]:
            failures.append(f"floor {f['floor']} bounds outside source by more than 0.5 m")
        if any(s["source_treads"] == 0 for s in f["stair_checks"]):
            failures.append(f"floor {f['floor']} stair wedge without source treads")
        if f["pillars_supported"] != f["pillars"]:
            failures.append(f"floor {f['floor']} pillar without source support")
        if f["ramps_supported"] != f["ramps"]:
            failures.append(f"floor {f['floor']} ramp without source support")
    scale = {
        "units": "metres",
        "source_triangles": int(sum(len(b.tris) for b in batches)),
        "all_levels_match": all(f["levels_match"] for f in report),
        "all_bounds_within_0_5m": all(f["bounds_within_0_5m"] for f in report),
    }
    result = {
        "pass": not failures,
        "failures": failures,
        "thresholds": {
            "floor_recall": 0.99,
            "solid_wall_precision": 0.85,
            "solid_wall_recall": 0.90,
            "wall_footprint_precision": 0.95,
            "wall_footprint_recall": 0.95,
            "bounds_margin_m": 0.5,
            "stair_source_treads": "at least one per wedge",
            "pillar_support": "all pillar boxes contain source geometry",
            "ramp_support": "all ramp slabs contain source geometry",
        },
        "scale": scale,
        "floors": report,
    }
    (OUT / "report.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    if failures:
        print("FAIL")
        for failure in failures:
            print(f"  {failure}")
        sys.exit(1)
    print("PASS")


if __name__ == "__main__":
    main()
