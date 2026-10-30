"""Build the interactive RPD quest data from the Claire A RPD locations.

The location graph and vanilla Claire A item ids come from the RE2R Archipelago
world data, which was checked against the game scenes in ``~/repos/reze``. The
walkable cells come from ``tools/rpd_grid.py``.

Run after ``tools/rpd_grid.py``. Writes ``public/rpd/quest.json``.
"""
from __future__ import annotations

import json
import math
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
GRID = ROOT / "public" / "rpd" / "grid.json"
SOURCE = ROOT / "tools" / "rpd_ap_source.json"
OUT = ROOT / "public" / "rpd" / "quest.json"

# Region anchors in source metres. The third value is the floor index.
REGION_ANCHORS = {
    "Main Hall": (0.0, 0.8, 4.0, 0),
    "Reception - RPD": (-20.0, 0.0, 16.0, 0),
    "East Hallway 1F": (25.0, 0.0, -5.0, 0),
    "East Hallway 1F Closet": (16.0, 0.0, -15.0, 0),
    "Press Room": (21.0, 0.0, -14.0, 0),
    "Bathroom": (34.0, 0.0, 0.0, 0),
    "Southwest Hallway": (-35.0, 0.0, -25.0, 0),
    "Records Room": (-30.0, 0.0, 0.0, 0),
    "Operations Room": (-31.0, 0.0, -17.0, 0),
    "Operations Room 2": (-25.0, 0.0, -8.0, 0),
    "West Hallway 1F": (-25.0, 0.0, -14.0, 0),
    "Safety Deposit Room": (-22.0, 0.0, -19.0, 0),
    "West Office": (-17.0, 0.0, -2.0, 0),
    "Darkroom": (-13.0, 0.0, -15.0, 0),
    "East Office": (20.0, 0.0, 2.0, 0),
    "Observation Room Hallway": (9.0, 0.0, -14.0, 0),
    "Observation Room": (9.0, 0.0, -20.0, 0),
    "Interrogation Room": (34.0, 0.0, 0.0, 0),
    "Library": (-18.0, 5.2, -8.0, 1),
    "Lounge - RPD": (-20.0, 5.2, 7.0, 1),
    "Waiting Room": (14.0, 5.2, 3.0, 1),
    "East Hallway 2F": (27.0, 5.2, -5.0, 1),
    "Art Room": (25.0, 5.2, -1.0, 1),
    "Fire Escape": (37.0, 5.2, -14.0, 1),
    "Shower Room": (-25.0, 5.2, -24.0, 1),
    "STARS Office Hallway": (-34.0, 5.2, -5.0, 1),
    "West Hallway 2F": (-24.0, 5.2, -5.0, 1),
    "STARS Office": (-29.0, 5.2, -9.0, 1),
    "Armory": (-32.0, 5.2, 3.0, 1),
    "Linen Room": (-20.0, 5.2, -19.0, 1),
    "Side Stairs": (-5.0, 5.2, -19.0, 1),
    "Chief's Office": (17.0, 5.2, -19.0, 1),
    "Private Collection Room": (17.0, 5.2, -12.0, 1),
    "Balcony": (0.0, 5.2, -16.0, 1),
    "West Hallway 3F": (-24.0, 10.4, -8.0, 2),
    "West Storage Room": (-30.0, 10.4, -4.0, 2),
    "East Storage Room": (31.0, 10.4, -15.0, 2),
    "Small Storage Room": (-21.0, 10.4, -22.0, 2),
    "Clock Tower": (30.0, 10.4, -16.0, 2),
    "Main Hall 3F": (-8.0, 10.4, -15.0, 2),
    "Roof": (28.0, 10.4, -5.0, 2),
}

# Doors are placed at the RPD's actual openings. Coordinates are in source
# metres on the room's floor; the region pair is sorted so either direction
# matches.
DOOR_POSITIONS = {
    "East Hallway 1F Closet|East Hallway 1F": (17.0, -11.0),
    "East Hallway 1F|Press Room": (21.0, -9.0),
    "Bathroom|East Hallway 1F": (30.0, -2.0),
    "East Hallway 1F|East Office": (17.0, 2.0),
    "Main Hall|Reception - RPD": (-8.0, 10.0),
    "Operations Room 2|Records Room": (-28.0, -4.0),
    "Operations Room|Southwest Hallway": (-33.0, -22.0),
    "Operations Room 2|Operations Room": (-28.0, -13.0),
    "Operations Room|West Hallway 1F": (-28.0, -15.0),
    "Operations Room 2|West Hallway 1F": (-25.0, -11.0),
    "Safety Deposit Room|West Hallway 1F": (-23.0, -16.0),
    "West Hallway 1F|West Office": (-20.0, -7.0),
    "Main Hall|West Office": (-8.0, -2.0),
    "Darkroom|West Hallway 1F": (-17.0, -14.0),
    "STARS Office Hallway|STARS Office": (-32.0, -7.0),
    "Armory|STARS Office": (-31.0, 0.0),
    "Library|Lounge - RPD": (-19.0, 0.0),
    "East Hallway 2F|Waiting Room": (19.0, 0.0),
    "Art Room|East Hallway 2F": (25.0, -4.0),
    "East Hallway 2F|Fire Escape": (34.0, -10.0),
    "Chief's Office|Private Collection Room": (17.0, -15.0),
    "Balcony|Side Stairs": (-3.0, -18.0),
    "West Hallway 3F|West Storage Room": (-27.0, -6.0),
    "Clock Tower|Main Hall 3F": (11.0, -16.0),
}

def condition_options(required):
    """The AP schema uses plain strings for an AND set and nested lists for OR."""
    if not required:
        return []
    if all(not isinstance(item, list) for item in required):
        return [sorted(set(required))]
    options = []
    for item in required:
        if isinstance(item, list):
            options.append(sorted(set(item)))
        else:
            options.append([item])
    return options


CONTAINER_LOCATIONS = ("hiding place", "locker", "maiden statue", "secured area")


def is_container(name: str) -> bool:
    lowered = name.lower()
    return any(key in lowered for key in CONTAINER_LOCATIONS)


# Items that open a door directly. Puzzle pieces (medallions, gears, books,
# statue parts) gate a mechanism inside a room, not the door itself, so those
# doors stay passable and are marked unknown.
KEY_ITEMS = {
    "Spade Key",
    "Heart Key",
    "Diamond Key",
    "Courtyard Key",
    "Bolt Cutters",
    "Valve Handle",
    "Car Key",
    "Parking Garage Key Card",
    "Weapons Locker Key Card",
    "Mechanic Jack Handle",
    "T-Bar Handle",
    "Square Crank",
    "Fuse - Main Hall",
    "Fuse - Break Room Hallway",
    "Sewers Key",
    "STARS Badge",
    "Joint Plug",
    "Signal Modulator",
}

ITEM_STYLE = {
    "Key": ("key", "pyramid", "#b45cff"),
    "Gating": ("gating", "pyramid", "#ff5cd0"),
    "Recovery": ("healing", "sphere", "#43d17a"),
    "Ammo": ("ammo", "cube", "#f2c94c"),
    "Gunpowder": ("powder", "cube", "#f2994a"),
    "Weapon": ("weapon", "cylinder", "#ff7a45"),
    "Subweapon": ("subweapon", "sphere", "#ffd166"),
    "Upgrade": ("upgrade", "cylinder", "#2dd4bf"),
    "Consumable": ("consumable", "cube", "#a97142"),
    "Lore": ("lore", "cube", "#9aa0a6"),
    "Filler": ("misc", "cube", "#9aa0a6"),
    "Trap": ("misc", "cube", "#9aa0a6"),
}
SPECIAL_STYLE = {
    "Ink Ribbon": ("ink", "cylinder", "#f0f0f0"),
    "Hip Pouch": ("equipment", "cylinder", "#4d9de0"),
}


def hex_rgb(value: str):
    value = value.lstrip("#")
    return [int(value[i : i + 2], 16) for i in (0, 2, 4)]


def load() -> tuple[dict, list[dict], list[dict]]:
    grid = json.loads(GRID.read_text())
    source = json.loads(SOURCE.read_text())
    cells_by_floor = {
        floor["index"]: [(c[0], c[1], c[2]) for c in floor["cells"]]
        for floor in grid["floors"]
    }
    return source, grid["floors"], cells_by_floor


def snap(cells, x, z, y):
    return min(cells, key=lambda c: (c[0] - x) ** 2 + (c[1] - z) ** 2 + 4.0 * (c[2] - y) ** 2)


def main() -> None:
    source, floor_meta, cells_by_floor = load()
    regions_by_name = {r["name"]: r for r in source["regions"]}

    rooms = {}
    home = {}
    for name, (x, y, z, floor) in REGION_ANCHORS.items():
        if name not in regions_by_name:
            continue
        cell = snap(cells_by_floor[floor], x, z, y)
        home[name] = cell
        rooms[name] = {
            "name": name,
            "floor": floor,
            "level": cell[2],
            "x": cell[0],
            "y": cell[2],
            "z": cell[1],
            "zone": regions_by_name[name]["zone_id"],
        }

    # Hardcore replaces a location with the same region and name.
    merged: dict[tuple[str, str], dict] = {}
    for loc in source["locations"]:
        if loc.get("region") in rooms:
            merged[(loc["region"], loc["name"])] = loc
    for loc in source["hardcore"]:
        if loc.get("region") in rooms and loc.get("original_item"):
            merged[(loc["region"], loc["name"])] = loc

    # Assign every cell to the nearest region anchor on its floor. Used only to
    # find plausible door positions at the boundary between two regions.
    cell_region = {}
    for floor, cells in cells_by_floor.items():
        names = [n for n, r in rooms.items() if r["floor"] == floor]
        for cell in cells:
            best = min(names, key=lambda n: (home[n][0] - cell[0]) ** 2 + (home[n][1] - cell[1]) ** 2)
            cell_region[(cell[0], cell[1], cell[2])] = best

    # Doors from region connections. Same-floor constraints are physical doors;
    # different floors are stairs and stay as plain graph edges.
    # Short narrow-gap cells mark real doorway openings in the RPD shell.
    doorway_points = {}
    for floor, cells in cells_by_floor.items():
        cell_set = {(round(c[0], 2), round(c[1], 2)) for c in cells}
        points = {}
        for x, z in cell_set:
            north = (x, z + 1) in cell_set
            south = (x, z - 1) in cell_set
            east = (x + 1, z) in cell_set
            west = (x - 1, z) in cell_set
            if north and south and not east and not west:
                points[(x, z)] = "ns"
            elif east and west and not north and not south:
                points[(x, z)] = "ew"
        seen = set()
        good = []
        for point in points:
            if point in seen:
                continue
            stack = [point]
            seen.add(point)
            comp = []
            orientation = points[point]
            while stack:
                cx, cz = stack.pop()
                comp.append((cx, cz))
                for nb in ((cx + 1, cz), (cx - 1, cz), (cx, cz + 1), (cx, cz - 1)):
                    if nb in points and nb not in seen and points[nb] == orientation:
                        seen.add(nb)
                        stack.append(nb)
            if len(comp) <= 3:
                good.append((
                    sum(p[0] for p in comp) / len(comp),
                    sum(p[1] for p in comp) / len(comp),
                    orientation,
                ))
        doorway_points[floor] = good

    doors = []
    edges = []
    for conn in source["connections"]:
        a, b = conn["from"], conn["to"]
        if a not in rooms or b not in rooms:
            continue
        condition = conn.get("condition") or {}
        required = condition.get("items", [])
        options = condition_options(required)
        flat_required = sorted({req for option in options for req in option})
        same_floor = rooms[a]["floor"] == rooms[b]["floor"]
        door_id = None
        if same_floor:
            cells_a = [c for c, r in cell_region.items() if r == a]
            cells_b = [c for c, r in cell_region.items() if r == b]
            best_pair = None
            for ca in cells_a:
                for cb in cells_b:
                    d = (ca[0] - cb[0]) ** 2 + (ca[1] - cb[1]) ** 2
                    if best_pair is None or d < best_pair[0]:
                        best_pair = (d, ca, cb)
            if best_pair is not None and best_pair[0] <= 36.0:
                ca, cb = best_pair[1], best_pair[2]
                x = round(0.5 * (ca[0] + cb[0]), 2)
                z = round(0.5 * (ca[1] + cb[1]), 2)
                override = DOOR_POSITIONS.get("|".join(sorted((a, b))))
                candidates = doorway_points.get(rooms[a]["floor"], [])
                door_yaw = 0.0
                if override is not None:
                    x, z = override
                    dx = abs(rooms[a]["x"] - rooms[b]["x"])
                    dz = abs(rooms[a]["z"] - rooms[b]["z"])
                    door_yaw = math.pi / 2.0 if dx > dz else 0.0
                elif candidates:
                    ax, az = rooms[a]["x"], rooms[a]["z"]
                    bx, bz = rooms[b]["x"], rooms[b]["z"]
                    def door_score(p):
                        da = math.hypot(p[0] - ax, p[1] - az)
                        db = math.hypot(p[0] - bx, p[1] - bz)
                        mid = math.hypot(p[0] - x, p[1] - z)
                        return da + db + 1.6 * abs(da - db) + 0.25 * mid

                    nearest = min(candidates, key=door_score)
                    if door_score(nearest) < 75.0:
                        x, z = nearest[0], nearest[1]
                        door_yaw = 0.0 if nearest[2] == "ns" else math.pi / 2.0
                cell = snap(cells_by_floor[rooms[a]["floor"]], x, z, rooms[a]["level"])
                key_like = bool(flat_required) and all(item in KEY_ITEMS for item in flat_required)
                puzzle = bool(flat_required) and not key_like
                if conn.get("limitation") or puzzle:
                    state = "unknown"
                elif flat_required:
                    state = "locked"
                else:
                    state = "unlocked"
                door_id = f"door-{len(doors):02d}"
                doors.append(
                    {
                        "id": door_id,
                        "from": a,
                        "to": b,
                        "x": cell[0],
                        "y": cell[2],
                        "z": cell[1],
                        "state": state,
                        "requires": flat_required,
                        "options": options,
                        "puzzle": puzzle,
                        "label": f"{a} <-> {b}",
                        "yaw": round(door_yaw, 4),
                        "oneWay": conn.get("limitation") == "ONE_SIDED_DOOR",
                    }
                )
        edges.append({"from": a, "to": b, "door": door_id})

    # Items, with deterministic offsets around the room anchor.
    items = []
    used = {}
    for index, ((region, name), loc) in enumerate(sorted(merged.items())):
        item_name = loc.get("original_item") or "Ink Ribbon"
        item_condition = loc.get("condition") or {}
        item_required = item_condition.get("items", []) if isinstance(item_condition, dict) else []
        item_options = condition_options(item_required) if is_container(name) else []
        item_requires = sorted({req for option in item_options for req in option})
        style = SPECIAL_STYLE.get(item_name) or ITEM_STYLE.get(
            source["item_types"].get(item_name, {}).get("type", ""), ("misc", "cube", "#9aa0a6")
        )
        category, shape, colour = style
        cell = home[region]
        count = used.get(region, 0)
        used[region] = count + 1
        angle = count * 2.399963
        radius = 1.4 + 0.75 * math.sqrt(count)
        x = cell[0] + radius * math.cos(angle)
        z = cell[1] + radius * math.sin(angle)
        pos = snap(cells_by_floor[rooms[region]["floor"]], x, z, cell[2])
        item_id = f"item-{index:03d}"
        items.append(
            {
                "id": item_id,
                "name": item_name,
                "location": name,
                "region": region,
                "category": category,
                "shape": shape,
                "color": colour,
                "rgb": hex_rgb(colour),
                "x": pos[0],
                "y": round(pos[2] + 0.36, 3),
                "z": pos[1],
                "links": [],
                "itemLinks": [],
                "requires": item_requires,
                "options": item_options,
            }
        )

    # Item-to-item links from the location conditions (lockers, safes,
    # puzzle containers). Each copy of the key item points at the reward.
    for item in items:
        for required in item["requires"]:
            for other in items:
                if other["name"] == required and other["id"] != item["id"]:
                    if item["id"] not in other["itemLinks"]:
                        other["itemLinks"].append(item["id"])

    # Item-to-door links by required item name.
    for door in doors:
        for req in door["requires"]:
            for item in items:
                if item["name"] == req and door["id"] not in item["links"]:
                    item["links"].append(door["id"])

    spawn_cell = snap(cells_by_floor[0], 0.0, 8.0, 0.8)
    payload = {
        "spawn": [spawn_cell[0], round(spawn_cell[2] + 0.45, 3), spawn_cell[1]],
        "floors": floor_meta,
        "rooms": list(rooms.values()),
        "items": items,
        "doors": doors,
        "edges": edges,
        "source": "RE2R Archipelago Claire A RPD locations; RPD floors 1-3, Hardcore overrides",
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    print(
        f"rooms {len(rooms)} items {len(items)} doors {len(doors)} edges {len(edges)}",
        flush=True,
    )
    print(f"wrote {OUT.relative_to(ROOT)}", flush=True)


if __name__ == "__main__":
    main()
