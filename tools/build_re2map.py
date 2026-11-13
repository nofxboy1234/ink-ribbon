#!/usr/bin/env python3
"""Build the sokol 2D map model from the EvilResource floor plans.

The plans are transparent line art: opaque grey/black walls and orange door
bars, with the room interiors transparent. Rooms are the transparent regions
enclosed by walls; each gets a polygon, a world centre and the nearest quest
room name. Doors, items and stair portals come from the extracted game data.

Requires opencv-python-headless and numpy.
"""

from __future__ import annotations

import json
import pathlib

import cv2
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "re2map"
DEBUG = ROOT / "verification" / "re2map"
FLOORS = {
    "1F": {"index": 0, "plan": "1f.png", "level": 0.0},
    "2F": {"index": 1, "plan": "2f.png", "level": 5.2},
    "3F": {"index": 2, "plan": "3f.png", "level": 10.4},
}
PROGRESSION = {
    "Officer's Notebook",
    "Combat Knife",
    "Police Station 1F Map",
    "Spade Key",
    "Police Station Upper Floors Map",
}
CATEGORY_COLOURS = {
    "Keys": (158, 79, 242), "Locks": (242, 140, 51), "Files": (230, 230, 214),
    "Weapons": (230, 71, 71), "Ammo": (242, 209, 77), "Herbs": (89, 217, 102),
    "Containers": (153, 107, 64), "Puzzle": (77, 217, 217),
}


def floor_of(level: float) -> str:
    return min(FLOORS, key=lambda name: abs(FLOORS[name]["level"] - level))


def to_plan(x: float, z: float, cal: dict) -> list[float]:
    return [cal["ox"] + x * cal["s"], cal["oy"] + z * cal["s"]]


def to_world(px: float, py: float, cal: dict) -> tuple[float, float]:
    return (px - cal["ox"]) / cal["s"], (py - cal["oy"]) / cal["s"]


def main() -> None:
    quest = json.loads((ROOT / "public" / "rpd" / "quest.json").read_text())
    registry = json.loads((ROOT / "public" / "rpd" / "item_registry.json").read_text())["items"]
    mapgenie = json.loads((ROOT / "public" / "rpd" / "items_mapgenie.json").read_text())
    nav = json.loads((ROOT / "public" / "rpd" / "nav.json").read_text())
    rooms_by_floor: dict[int, list[dict]] = {}
    for room in quest["rooms"]:
        rooms_by_floor.setdefault(room["floor"], []).append(room)

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "plans").mkdir(exist_ok=True)
    DEBUG.mkdir(parents=True, exist_ok=True)
    model = {"version": 1, "floors": [], "rooms": [], "doors": [], "items": [], "stairs": []}
    room_id = 0

    for name, meta in FLOORS.items():
        info = mapgenie["floors"][name]
        cal = info["calibration"]
        plan_path = ROOT / info["plan"]
        (OUT / "plans" / meta["plan"]).write_bytes(plan_path.read_bytes())
        img = cv2.imread(str(plan_path), cv2.IMREAD_UNCHANGED)
        if img is None or img.shape[2] != 4:
            raise SystemExit(f"plan is not RGBA: {plan_path}")
        h, w = img.shape[:2]
        transparent = (img[:, :, 3] == 0).astype(np.uint8)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(transparent, connectivity=4)
        outside = labels[0, 0]
        debug = img.copy()
        debug[:, :, 3] = 255
        debug[img[:, :, 3] == 0] = (24, 22, 20, 255)
        for i in range(1, count):
            if i == outside or stats[i, cv2.CC_STAT_AREA] < 150:
                continue
            mask = (labels == i).astype(np.uint8)
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            contour = max(contours, key=cv2.contourArea)
            poly = cv2.approxPolyDP(contour, 1.2, True).reshape(-1, 2)
            if len(poly) < 3:
                continue
            cx, cy = poly.mean(axis=0)
            wx, wz = to_world(float(cx), float(cy), cal)
            nearest = None
            best = 1e9
            for room in rooms_by_floor.get(meta["index"], []):
                d = (room["x"] - wx) ** 2 + (room["z"] - wz) ** 2
                if d < best:
                    best, nearest = d, room
            room_name = nearest["name"] if nearest and best <= 36.0 else None
            model["rooms"].append({
                "id": room_id,
                "floor": meta["index"],
                "name": room_name,
                "polygon": [[int(x), int(y)] for x, y in poly],
                "center": [int(cx), int(cy)],
                "world": [round(wx, 2), round(wz, 2)],
                "area": int(stats[i, cv2.CC_STAT_AREA]),
            })
            colour = tuple(int(c) for c in np.random.default_rng(room_id).integers(60, 230, 3))
            cv2.polylines(debug, [poly], True, colour + (255,), 1, cv2.LINE_AA)
            room_id += 1
        cv2.imwrite(str(DEBUG / f"rooms-{name}.png"), debug)
        model["floors"].append({
            "index": meta["index"],
            "label": name,
            "level": info["level"],
            "plan": f"plans/{meta['plan']}",
            "plan_size": [w, h],
            "calibration": cal,
            "bounds": [[round((0 - cal["ox"]) / cal["s"], 1), round((h - cal["oy"]) / cal["s"], 1)],
                       [round((w - cal["ox"]) / cal["s"], 1), round((0 - cal["oy"]) / cal["s"], 1)]],
        })

    for door in quest["doors"]:
        floor_name = floor_of(float(door.get("y", 0.0)))
        cal = mapgenie["floors"][floor_name]["calibration"]
        px = to_plan(door["x"], door["z"], cal)
        if not (0 <= px[0] <= mapgenie["floors"][floor_name]["plan_size"][0] and 0 <= px[1] <= mapgenie["floors"][floor_name]["plan_size"][1]):
            continue
        model["doors"].append({
            "id": door["id"], "floor": FLOORS[floor_name]["index"], "name": door.get("label", ""),
            "x": door["x"], "z": door["z"], "plan": [round(px[0], 1), round(px[1], 1)],
            "yaw": door.get("yaw", 0.0), "state": door.get("state", "unknown"),
            "requires": door.get("requires", []), "locked": door.get("state") == "locked",
        })

    for item in registry:
        floor_name = next((n for n, m in FLOORS.items() if m["index"] == item["floor"]), None)
        if floor_name is None:
            continue
        cal = mapgenie["floors"][floor_name]["calibration"]
        px = to_plan(item["x"], item["z"], cal)
        colour = CATEGORY_COLOURS.get(item["category"], (255, 255, 255))
        model["items"].append({
            "id": item["id"], "name": item["title"], "floor": item["floor"],
            "x": item["x"], "z": item["z"], "plan": [round(px[0], 1), round(px[1], 1)],
            "category": item["category"], "colour": list(colour), "action": item["action"],
            "progression": item["title"] in PROGRESSION,
        })

    nodes = nav["nodes"]
    for a, b in nav["portals"]:
        na, nb = nodes[a], nodes[b]
        if na["floor"] == nb["floor"]:
            continue
        for node in (na, nb):
            floor_name = next((n for n, m in FLOORS.items() if m["index"] == node["floor"]), None)
            if floor_name is None:
                continue
            cal = mapgenie["floors"][floor_name]["calibration"]
            px = to_plan(node["x"], node["z"], cal)
            model["stairs"].append({
                "floor": node["floor"], "to": nb["floor"] if node is na else na["floor"],
                "x": node["x"], "z": node["z"], "plan": [round(px[0], 1), round(px[1], 1)],
            })

    (OUT / "map.json").write_text(json.dumps(model, indent=1))
    print(f"floors {len(model['floors'])} rooms {len(model['rooms'])} doors {len(model['doors'])} "
          f"items {len(model['items'])} stairs {len(model['stairs'])}")


if __name__ == "__main__":
    main()
