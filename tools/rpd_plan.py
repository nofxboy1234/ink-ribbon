#!/usr/bin/env python3
"""Build the RPD black-on-white building and a fresh navigation graph.

The evilresource floor plans are line drawings of the real station. Each plan is
calibrated into the game's world frame (metres, Y up) around a fixed pixels per
metre scale. The script then:

* separates walls, doors and stair hatching,
* greedy-meshes the wall and floor masks into a small set of boxes,
* lays a fresh 1 m navigation lattice over each plan's walkable area,
* stitches the floors together with ramp chains at the stairwells,
* writes ``public/rpd/plan.json`` (boxes for Blender) and
  ``public/rpd/nav.json`` (the five-floor graph).

Run with::

    uv run --with numpy --with scipy --with opencv-python-headless python tools/rpd_plan.py
"""
from __future__ import annotations

import json
import math
import pathlib
import sys

import cv2
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
PLANS = ROOT / "tools" / "rpd_plans"
OUT_PLAN = ROOT / "public" / "rpd" / "plan.json"
OUT_NAV = ROOT / "public" / "rpd" / "nav.json"

# Pixels per metre and the world position of plan pixel (0, 0).
# 1F-3F come from matching the plan to the decompiled floor geometry.
# 4F and B1 are placed by matching their connection stair to the stair they
# serve on 3F and 1F respectively.
FLOORS = [
    {"index": 0, "label": "1F", "level": 0.0, "image": "1f", "s": 6.63, "ox": 291.0, "oy": 240.0},
    {"index": 1, "label": "2F", "level": 5.2, "image": "2f", "s": 6.45, "ox": 262.0, "oy": 169.0},
    {"index": 2, "label": "3F", "level": 10.4, "image": "3f", "s": 6.78, "ox": 253.0, "oy": 176.0},
    {"index": 3, "label": "4F", "level": 15.6, "image": "4f", "s": 6.78, "ox": -136.8, "oy": 137.4},
    {"index": 4, "label": "B1", "level": -5.2, "image": "b1", "s": 6.45, "ox": 333.45, "oy": 0.65},
]
FLOOR_BY_LABEL = {floor["label"]: floor for floor in FLOORS}

FLOOR_THICKNESS = 0.34
WALL_HEIGHT = 2.85
WALL_CAP = 0.07
STAIR_RISE = 0.5

COLOUR_FLOOR = (244, 242, 235)
COLOUR_WALL = (232, 229, 219)
COLOUR_CAP = (38, 38, 38)
COLOUR_STAIR = (206, 202, 192)
COLOUR_TREAD = (52, 52, 52)

# World-space stairwells taken from the decompiled navigation (two floors at a
# time). Each entry is (x, z, lower floor label, upper floor label).
STAIRS = [
    (-14.0, -21.0, "1F", "2F"),
    (30.5, -19.5, "1F", "2F"),
    (39.0, 3.0, "1F", "2F"),
    (40.5, -22.5, "1F", "2F"),
    (-14.0, -23.0, "2F", "3F"),
    (30.5, -18.5, "2F", "3F"),
    (30.5, -18.5, "3F", "4F"),
    (39.0, 3.0, "B1", "1F"),
]


def load_plan(floor: dict) -> dict:
    image = cv2.imread(str(PLANS / f"{floor['image']}.png"), cv2.IMREAD_UNCHANGED)
    if image is None:
        sys.exit(f"missing plan {floor['image']}.png")
    if image.shape[2] == 4:
        b, g, r, a = cv2.split(image)
    else:
        b, g, r = cv2.split(image)
        a = np.full_like(b, 255)
    alpha = a > 128
    # The evilresource GIFs use a four colour palette: transparent, wall grey,
    # black detail and the orange door block.
    orange = alpha & (r > 150) & (g > 90) & (g < 200) & (b < 120)
    wall = alpha & ~orange
    # The plans draw walls as two hairlines around the wall thickness. Close
    # the pair into one solid wall so the paper model has real wall volumes.
    wall = cv2.morphologyEx(
        wall.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)
    ) > 0
    # The one pixel frame is not a wall.
    frame = np.zeros_like(wall)
    frame[0, :] = frame[-1, :] = True
    frame[:, 0] = frame[:, -1] = True
    return {"alpha": alpha, "wall": wall & ~frame, "door": orange, "frame": frame}


def world_of(floor: dict, px: float, py: float) -> tuple[float, float]:
    return ((px - floor["ox"]) / floor["s"], (py - floor["oy"]) / floor["s"])


def pixel_of(floor: dict, x: float, z: float) -> tuple[float, float]:
    return (x * floor["s"] + floor["ox"], z * floor["s"] + floor["oy"])


def free_and_outside(wall: np.ndarray, frame: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Return free space and the exterior region inside the map frame."""
    barrier = wall if frame is None else (wall | frame)
    free = (~barrier).astype(np.uint8)
    h, w = free.shape
    seeds = [(1, 1), (w - 2, 1), (1, h - 2), (w - 2, h - 2)]
    outside = np.zeros((h, w), np.uint8)
    work = free.copy()
    for x, y in seeds:
        if work[y, x]:
            mask = np.zeros((h + 2, w + 2), np.uint8)
            cv2.floodFill(work, mask, (x, y), 2)
    outside = work == 2
    return (free == 1) & ~frame if frame is not None else (free == 1), outside


def greedy_rects(mask: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Cover a binary mask with as few axis-aligned rectangles as possible."""
    h, w = mask.shape
    rects: list[tuple[int, int, int, int]] = []
    open_rows: dict[tuple[int, int], int] = {}
    for y in range(h):
        row = mask[y]
        runs: set[tuple[int, int]] = set()
        x = 0
        while x < w:
            if not row[x]:
                x += 1
                continue
            start = x
            while x < w and row[x]:
                x += 1
            runs.add((start, x))
        for key in list(open_rows):
            if key not in runs:
                rects.append((key[0], open_rows.pop(key), key[1], y))
        for key in runs:
            open_rows.setdefault(key, y)
    for key, y0 in open_rows.items():
        rects.append((key[0], y0, key[1], h))
    return rects


def box_from_rect(floor: dict, rect: tuple[int, int, int, int], level: float, height: float, colour):
    x0, y0, x1, y1 = rect
    wx0, wz0 = world_of(floor, x0, y0)
    wx1, wz1 = world_of(floor, x1, y1)
    return {
        "x0": round(min(wx0, wx1), 3),
        "z0": round(min(wz0, wz1), 3),
        "x1": round(max(wx0, wx1), 3),
        "z1": round(max(wz0, wz1), 3),
        "y0": round(level, 3),
        "y1": round(level + height, 3),
        "c": list(colour),
    }


def stair_rect_mask(shape, floor: dict) -> np.ndarray:
    """Mask the stairwell footprints so they become stairs, not walls."""
    mask = np.zeros(shape, np.uint8)
    for x, z, lo, hi in STAIRS:
        if floor["label"] not in (lo, hi):
            continue
        px, py = pixel_of(floor, x, z)
        r = int(round(1.15 * floor["s"]))
        cv2.circle(mask, (int(round(px)), int(round(py))), r, 1, -1)
    return mask.astype(bool)


def thicken(box: dict, minimum: float = 0.42) -> dict:
    """Keep hairline walls visible at plan zoom by giving them a minimum width."""
    cx = 0.5 * (box["x0"] + box["x1"])
    cz = 0.5 * (box["z0"] + box["z1"])
    w = box["x1"] - box["x0"]
    d = box["z1"] - box["z0"]
    if w < minimum:
        box["x0"], box["x1"] = cx - minimum / 2, cx + minimum / 2
    if d < minimum:
        box["z0"], box["z1"] = cz - minimum / 2, cz + minimum / 2
    return box


def build_floor_geometry(floor: dict, plan: dict) -> list[dict]:
    level = floor["level"]
    wall = plan["wall"].copy()
    wall &= ~stair_rect_mask(wall.shape, floor)
    free, outside = free_and_outside(wall, plan["frame"])
    # Doors are free floor.
    interior = free & ~outside
    if floor["label"] == "4F":
        # The tiny clock-tower plan only draws its wall outline, so fill the
        # whole tower room inside that outline instead of the open notch.
        ys, xs = np.where(wall)
        if len(xs):
            x0, x1 = xs.min(), xs.max()
            y0, y1 = ys.min(), ys.max()
            room = np.zeros_like(wall)
            room[max(0, y0 - 1):min(room.shape[0], y1 + 2),
                 max(0, x0 - 1):min(room.shape[1], x1 + 2)] = True
            interior = room & ~wall
    boxes: list[dict] = []
    for rect in greedy_rects(interior):
        slab = box_from_rect(floor, rect, level - FLOOR_THICKNESS, FLOOR_THICKNESS, COLOUR_FLOOR)
        # Overlap neighbouring slabs by a few centimetres so the ink pass does
        # not outline the seams between them.
        slab["x0"] -= 0.04
        slab["z0"] -= 0.04
        slab["x1"] += 0.04
        slab["z1"] += 0.04
        boxes.append(slab)
    for rect in greedy_rects(wall):
        body = thicken(box_from_rect(floor, rect, level, WALL_HEIGHT - WALL_CAP, COLOUR_WALL))
        boxes.append(body)
        cap = dict(body)
        cap["y0"] = round(level + WALL_HEIGHT - WALL_CAP, 3)
        cap["y1"] = round(level + WALL_HEIGHT, 3)
        cap["c"] = list(COLOUR_CAP)
        boxes.append(cap)
    return boxes


def build_stairs(floor: dict) -> list[dict]:
    """Stepped treads where a stairwell meets this floor."""
    boxes: list[dict] = []
    for x, z, lo, hi in STAIRS:
        if floor["label"] != lo:
            continue
        upper = FLOOR_BY_LABEL[hi]
        y0 = floor["level"]
        y1 = upper["level"]
        steps = max(4, int(round((y1 - y0) / STAIR_RISE)))
        length = 1.6
        for i in range(steps):
            t = i / steps
            y = y0 + (y1 - y0) * (i + 0.5) / steps
            z0 = z - length / 2 + length * i / steps
            z1 = z - length / 2 + length * (i + 1) / steps
            boxes.append({
                "x0": round(x - 0.85, 3), "x1": round(x + 0.85, 3),
                "z0": round(z0, 3), "z1": round(z1, 3),
                "y0": round(y - STAIR_RISE, 3), "y1": round(y, 3),
                "c": list(COLOUR_STAIR if i % 2 == 0 else COLOUR_TREAD),
            })
    return boxes


def nav_cells(floor: dict, plan: dict) -> tuple[list[dict], dict[tuple[int, int], int]]:
    """A fresh 1 m lattice over the walkable part of the plan."""
    free, outside = free_and_outside(plan["wall"], plan["frame"])
    walk = free & ~outside
    if floor["label"] == "4F":
        ys, xs = np.where(plan["wall"])
        if len(xs):
            room = np.zeros_like(walk)
            room[max(0, ys.min() - 1):min(room.shape[0], ys.max() + 2),
                 max(0, xs.min() - 1):min(room.shape[1], xs.max() + 2)] = True
            walk = room & ~plan["wall"] & ~plan["frame"]
    # Ignore stair footprints for the floor lattice; the ramp chain covers them.
    walk &= ~stair_rect_mask(walk.shape, floor)
    s = floor["s"]
    half = 0.5
    # The lattice is anchored on whole metres in world space.
    xs, zs = np.where(walk)
    if len(xs) == 0:
        return [], {}
    wx = (xs - floor["ox"]) / s
    wz = (zs - floor["oy"]) / s
    x_min, x_max = math.floor(wx.min()) - 1, math.ceil(wx.max()) + 1
    z_min, z_max = math.floor(wz.min()) - 1, math.ceil(wz.max()) + 1
    cells: list[dict] = []
    index: dict[tuple[int, int], int] = {}
    for zi in range(z_min, z_max + 1):
        for xi in range(x_min, x_max + 1):
            px, py = pixel_of(floor, xi + 0.5, zi + 0.5)
            ix, iy = int(round(px)), int(round(py))
            if not (0 <= ix < walk.shape[1] and 0 <= iy < walk.shape[0]):
                continue
            if not walk[iy, ix]:
                continue
            # Require a little clearance so cells do not sit inside a wall.
            r = max(1, int(round(0.32 * s)))
            y0, y1 = max(0, iy - r), min(walk.shape[0], iy + r + 1)
            x0, x1 = max(0, ix - r), min(walk.shape[1], ix + r + 1)
            if not walk[y0:y1, x0:x1].all():
                continue
            index[(xi, zi)] = len(cells)
            cells.append({
                "x": float(xi + 0.5),
                "y": floor["level"] + 0.02,
                "z": float(zi + 0.5),
                "floor": floor["index"],
                "kind": "floor",
                "n": [],
            })
    # Door centres become cells so gaps narrower than the lattice still connect.
    for py, px in zip(*np.where(plan["door"])):
        wx = (px - floor["ox"]) / s
        wz = (py - floor["oy"]) / s
        key = (round(wx), round(wz))
        if key in index:
            continue
        node = len(cells)
        index[key] = node
        cells.append({
            "x": float(key[0]),
            "y": floor["level"] + 0.02,
            "z": float(key[1]),
            "floor": floor["index"],
            "kind": "floor",
            "n": [],
        })
    # Four-way lattice edges.
    for (xi, zi), node in index.items():
        for dx, dz in ((1, 0), (0, 1)):
            other = index.get((xi + dx, zi + dz))
            if other is not None:
                cells[node]["n"].append(other)
                cells[other]["n"].append(node)
    # Bridge door cells to the nearest lattice cells on either side.
    for py, px in zip(*np.where(plan["door"])):
        wx = (px - floor["ox"]) / s
        wz = (py - floor["oy"]) / s
        node = index.get((round(wx), round(wz)))
        if node is None:
            continue
        near = sorted(
            (i for i in range(len(cells)) if i != node),
            key=lambda i: (cells[i]["x"] - cells[node]["x"]) ** 2 + (cells[i]["z"] - cells[node]["z"]) ** 2,
        )[:4]
        for other in near:
            if abs(cells[other]["x"] - cells[node]["x"]) > 2.2 and abs(cells[other]["z"] - cells[node]["z"]) > 2.2:
                continue
            if math.dist((cells[other]["x"], cells[other]["z"]), (cells[node]["x"], cells[node]["z"])) > 2.6:
                continue
            if other not in cells[node]["n"]:
                cells[node]["n"].append(other)
                cells[other]["n"].append(node)
    return cells, index


def ramp_chain(cells: list[dict], floor: dict, x: float, z: float, other_level: float, kind: str) -> tuple[list[int], list[int]]:
    """Add a walkable chain of nodes climbing the stairwell between two floors."""
    steps = max(6, int(round(abs(other_level - floor["level"]) / STAIR_RISE)))
    ids: list[int] = []
    for i in range(steps + 1):
        t = i / steps
        y = floor["level"] + (other_level - floor["level"]) * t
        zz = z + 0.9 - 1.8 * t
        ids.append(len(cells))
        cells.append({
            "x": float(round(x, 2)),
            "y": round(y + 0.02, 3),
            "z": round(zz, 3),
            "floor": floor["index"],
            "kind": kind,
            "n": [],
        })
    for a, b in zip(ids, ids[1:]):
        cells[a]["n"].append(b)
        cells[b]["n"].append(a)
    # Attach the bottom of the chain to the room lattice.
    anchor = min(
        (i for i in range(len(cells)) if i not in ids and cells[i]["floor"] == floor["index"]),
        key=lambda i: (cells[i]["x"] - x) ** 2 + (cells[i]["z"] - z) ** 2,
        default=None,
    )
    if anchor is not None and math.dist((cells[anchor]["x"], cells[anchor]["z"]), (x, z)) < 3.0:
        cells[anchor]["n"].append(ids[0])
        cells[ids[0]]["n"].append(anchor)
    return ids, []


def main() -> int:
    plans = {floor["label"]: load_plan(floor) for floor in FLOORS}
    geometry: dict[str, list[dict]] = {}
    all_cells: list[dict] = []
    floor_ranges: dict[str, tuple[int, int]] = {}
    stair_links: list[tuple[str, str, int, int]] = []

    for floor in FLOORS:
        label = floor["label"]
        cells, index = nav_cells(floor, plans[label])
        base = len(all_cells)
        all_cells.extend(cells)
        floor_ranges[label] = (base, len(all_cells))
        boxes = build_floor_geometry(floor, plans[label])
        boxes += build_stairs(floor)
        geometry[label] = boxes
        print(f"{label}: {len(boxes)} boxes, {len(cells)} cells", flush=True)

    # Stair ramps between floors. The lower floor owns the chain; both ends are
    # linked to the closest floor cell of their own storey.
    ramp_ids: dict[tuple[str, str], list[int]] = {}
    for x, z, lo, hi in STAIRS:
        lower = FLOOR_BY_LABEL[lo]
        upper = FLOOR_BY_LABEL[hi]
        lo_base, lo_end = floor_ranges[lo]
        hi_base, hi_end = floor_ranges[hi]
        cells = all_cells
        # bottom half lives on the lower floor, top half on the upper floor
        steps = max(6, int(round(abs(upper["level"] - lower["level"]) / STAIR_RISE)))
        chain: list[int] = []
        for i in range(steps + 1):
            t = i / steps
            y = lower["level"] + (upper["level"] - lower["level"]) * t
            zz = z + 0.9 - 1.8 * t
            floor_index = lower["index"] if t < 0.5 else upper["index"]
            chain.append(len(cells))
            cells.append({
                "x": round(x, 2),
                "y": round(y + 0.02, 3),
                "z": round(zz, 3),
                "floor": floor_index,
                "kind": "stair",
                "n": [],
            })
        for a, b in zip(chain, chain[1:]):
            cells[a]["n"].append(b)
            cells[b]["n"].append(a)
        for end, label, base, endi in ((chain[0], lo, lo_base, lo_end), (chain[-1], hi, hi_base, hi_end)):
            candidates = sorted(
                range(base, endi),
                key=lambda i: (cells[i]["x"] - x) ** 2 + (cells[i]["z"] - z) ** 2,
            )[:3]
            for anchor in candidates:
                if math.dist((cells[anchor]["x"], cells[anchor]["z"]), (x, z)) > 7.0:
                    continue
                cells[anchor]["n"].append(end)
                cells[end]["n"].append(anchor)
        stair_links.append((lo, hi, chain[0], chain[-1]))
    print(f"stairs: {len(stair_links)}, total cells: {len(all_cells)}", flush=True)

    # Validate: every node should be in one component per adjacent floor stack.
    parent = list(range(len(all_cells)))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i, cell in enumerate(all_cells):
        for j in cell["n"]:
            union(i, j)
    comps: dict[int, int] = {}
    for i in range(len(all_cells)):
        comps[find(i)] = comps.get(find(i), 0) + 1
    sizes = sorted(comps.values(), reverse=True)
    print(f"components: {len(sizes)}, largest: {sizes[0] if sizes else 0}, sizes: {sizes[:8]}", flush=True)

    floor_meta = []
    for f in FLOORS:
        boxes = geometry[f["label"]]
        b = [min(x["x0"] for x in boxes), min(x["z0"] for x in boxes),
             max(x["x1"] for x in boxes), max(x["z1"] for x in boxes)]
        floor_meta.append({"index": f["index"], "label": f["label"], "level": f["level"], "bounds": b})
    payload = {
        "version": 1,
        "step": 1.0,
        "half": 0.5,
        "floors": floor_meta,
        "nodes": all_cells,
        "portals": [[a, b] for _lo, _hi, a, b in stair_links],
    }
    OUT_NAV.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT_NAV.relative_to(ROOT)} ({OUT_NAV.stat().st_size / 1024:.0f} KiB)", flush=True)

    plan_payload = {
        "version": 1,
        "floors": [
            {
                "index": f["index"],
                "label": f["label"],
                "level": f["level"],
                "boxes": geometry[f["label"]],
            }
            for f in FLOORS
        ],
    }
    OUT_PLAN.write_text(json.dumps(plan_payload, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT_PLAN.relative_to(ROOT)} ({OUT_PLAN.stat().st_size / 1024:.0f} KiB)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
