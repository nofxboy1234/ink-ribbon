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
import struct

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


def in_poly(x: float, y: float, poly: list) -> bool:
    inside = False
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / (y1 - y0) + x0:
            inside = not inside
    return inside



def signed_area(poly):
    return 0.5 * sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1] for i in range(len(poly)))


def point_in_tri(p, a, b, c):
    def cross(u, v, w):
        return (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0])
    return cross(a, b, p) >= 0 and cross(b, c, p) >= 0 and cross(c, a, p) >= 0


def earclip(poly):
    idx = list(range(len(poly)))
    if signed_area(poly) < 0:
        idx.reverse()
    tris = []
    guard = 0
    while len(idx) > 3 and guard < 2000:
        guard += 1
        ear = False
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            a, b, c = poly[i0], poly[i1], poly[i2]
            if (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) <= 0:
                continue
            if any(point_in_tri(poly[j], a, b, c) for j in idx if j not in (i0, i1, i2)):
                continue
            tris.append((i0, i1, i2))
            idx.pop(k)
            ear = True
            break
        if not ear:
            break
    if len(idx) == 3:
        tris.append(tuple(idx))
    return tris


def pack_map(model, floor_info, path):
    out = bytearray()
    def u32(v): out.extend(struct.pack('<I', v))
    def f32(v): out.extend(struct.pack('<f', v))
    out.extend(b'R2M1'); u32(2); u32(len(floor_info))
    for name, info in floor_info.items():
        meta = model['floors'][info['index']]
        cal = meta['calibration']
        level = struct.unpack('<f', struct.pack('<f', meta['level']))[0]
        f32(level)
        rooms = [r for r in model['rooms'] if r['floor'] == info['index']]
        vertices = []
        room_records = []
        triangles = []
        for room in rooms:
            poly = [(float(x), float(y)) for x, y in room['polygon']]
            start = len(vertices)
            for px, py in poly:
                x = (px - cal['ox']) / cal['s']
                z = (py - cal['oy']) / cal['s']
                vertices.append((x, z))
            for a, b, c in earclip(poly):
                triangles.append((start + a, start + b, start + c, len(room_records)))
            room_records.append((start, len(poly), 0))
        u32(len(room_records)); u32(len(vertices)); u32(len(triangles))
        for start, count, state in room_records:
            u32(start); u32(count); u32(state)
        for x, z in vertices:
            f32(x); f32(z)
        for a, b, c, r in triangles:
            u32(a); u32(b); u32(c); u32(r)
        doors = [d for d in model['doors'] if d['floor'] == info['index']]
        u32(len(doors))
        for d in doors:
            px, py = d['plan']
            x = (px - cal['ox']) / cal['s']
            z = (py - cal['oy']) / cal['s']
            f32(x); f32(z); f32(float(d['yaw'])); u32(int(d.get('key', 0))); u32(int(d.get('flags', 0)))
        items = [i for i in model['items'] if i['floor'] == info['index']]
        u32(len(items))
        for it in items:
            px, py = it['plan']
            x = (px - cal['ox']) / cal['s']
            z = (py - cal['oy']) / cal['s']
            colour = it['colour']
            f32(x); f32(z); u32(int(it['id'])); u32(int(it.get('room', -1)) & 0xFFFFFFFF); u32((colour[0] << 16) | (colour[1] << 8) | colour[2]); u32(1 if it.get('progression') else 0)
        stairs = [s for s in model['stairs'] if s['floor'] == info['index']]
        u32(len(stairs))
        for s in stairs:
            px, py = s['plan']
            x = (px - cal['ox']) / cal['s']
            z = (py - cal['oy']) / cal['s']
            f32(x); f32(z); u32(int(s['to']))
    pathlib.Path(path).write_bytes(bytes(out))


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

    door_titles = ("door", "gate", "taped box")
    quest_doors = []
    for door in quest["doors"]:
        floor_name = floor_of(float(door.get("y", 0.0)))
        cal = mapgenie["floors"][floor_name]["calibration"]
        px = to_plan(door["x"], door["z"], cal)
        entry = {
            "id": door["id"], "floor": FLOORS[floor_name]["index"], "name": door.get("label", ""),
            "x": door["x"], "z": door["z"], "plan": [round(px[0], 1), round(px[1], 1)],
            "yaw": door.get("yaw", 0.0), "key": 0, "flags": 0, "source": "quest",
        }
        quest_doors.append(entry)
        model["doors"].append(entry)
    for item in registry:
        if item["category"] != "Lock" or not any(t in item["title"].lower() for t in door_titles):
            continue
        floor_name = next((n for n, m in FLOORS.items() if m["index"] == item["floor"]), None)
        if floor_name is None:
            continue
        key = item["requires"][0] if item.get("requires") else 0
        near = None
        near_d = 4.0
        for door in quest_doors:
            if door["floor"] != item["floor"]:
                continue
            d = (door["x"] - item["x"]) ** 2 + (door["z"] - item["z"]) ** 2
            if d < near_d:
                near_d, near = d, door
        if near is not None:
            near["key"] = key
            near["flags"] = 1 if key else 0
            near["name"] = item["title"]
            continue
        cal = mapgenie["floors"][floor_name]["calibration"]
        px = to_plan(item["x"], item["z"], cal)
        yaw = 0.0
        best = 36.0
        for door in quest_doors:
            if door["floor"] != item["floor"]:
                continue
            d = (door["x"] - item["x"]) ** 2 + (door["z"] - item["z"]) ** 2
            if d < best:
                best, yaw = d, door["yaw"]
        model["doors"].append({
            "id": f"lock-{item['id']}", "floor": item["floor"], "name": item["title"],
            "x": item["x"], "z": item["z"], "plan": [round(px[0], 1), round(px[1], 1)],
            "yaw": yaw, "key": key, "flags": 1 if key else 0, "source": "lock",
        })

    for item in registry:
        floor_name = next((n for n, m in FLOORS.items() if m["index"] == item["floor"]), None)
        if floor_name is None:
            continue
        cal = mapgenie["floors"][floor_name]["calibration"]
        px = to_plan(item["x"], item["z"], cal)
        colour = CATEGORY_COLOURS.get(item["category"], (255, 255, 255))
        floor_rooms = [r for r in model["rooms"] if r["floor"] == item["floor"]]
        room_index = -1
        for index, room in enumerate(floor_rooms):
            if in_poly(px[0], px[1], room["polygon"]):
                room_index = index
                break
        model["items"].append({
            "id": item["id"], "name": item["title"], "floor": item["floor"],
            "x": item["x"], "z": item["z"], "plan": [round(px[0], 1), round(px[1], 1)],
            "category": item["category"], "colour": list(colour), "action": item["action"],
            "progression": item["title"] in PROGRESSION, "room": room_index,
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
    pack_map(model, FLOORS, OUT / "map.bin")
    print(f"floors {len(model['floors'])} rooms {len(model['rooms'])} doors {len(model['doors'])} "
          f"items {len(model['items'])} stairs {len(model['stairs'])}")


if __name__ == "__main__":
    main()
