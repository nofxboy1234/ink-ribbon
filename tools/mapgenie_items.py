#!/usr/bin/env python3
"""Map MapGenie RPD markers onto the sokol/Evil Resource world.

MapGenie stores a marker as latitude/longitude in a Web Mercator raster space
with no floor field. The raster carries all five RPD plans stacked north to
south (B1, 1F, 2F, 3F, 4F). The sokol world is built from the Evil Resource
plans that ``tools/rpd_plan.py`` calibrates. This script bridges the two:

    lat/lng -> z14 raster pixel -> Evil plan pixel -> sokol metres

Each floor has its own 2D affine from the raster pixel to the Evil plan pixel.
The affines were fitted with SIFT on Canny edges plus RANSAC (4F is fitted by
hand on the room outline because its raster drawing has different proportions
from the Evil plan). ``tools/mapgenie_overlay.py`` draws the result and checks
door markers against the orange door blocks in the Evil plans.

Run:

    curl -H 'User-Agent: Mozilla/5.0' -H 'Accept: application/json' \
        https://mapgenie.io/api/v1/maps/878/data -o /tmp/mapgenie/map-878.json
    python3 tools/mapgenie_items.py --map-json /tmp/mapgenie/map-878.json
    python3 tools/mapgenie_items.py --map-json /tmp/mapgenie/map-878.json --check
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
PLAN = ROOT / "public" / "rpd" / "plan.json"
NAV = ROOT / "public" / "rpd" / "nav.json"
OUT = ROOT / "public" / "rpd" / "items_mapgenie.json"
DATA_URL = "https://mapgenie.io/api/v1/maps/878/data"

# MapGenie exposes no floor field, so the floor is inferred from the latitude
# band each plan occupies in the stacked raster. Longitude keeps the RPD stack
# apart from the Underground Facility, sewers and the detached left plan.
BANDS = [
    ("B1", 0.665, 0.720),
    ("1F", 0.570, 0.630),
    ("2F", 0.475, 0.540),
    ("3F", 0.400, 0.465),
    ("4F", 0.365, 0.390),
]
LNG_MIN, LNG_MAX = -1.22, -1.05

# Assisted/Standard-only markers, removed by the MapGenie Hardcore filter.
EXCLUDED = {
    544552, 553822, 553824, 553827, 553831, 553833, 553828, 553832,
    553834, 553772, 597257, 553823, 553826, 560266,
}

CATEGORY_NAMES = {
    14873: "Item Box",
    14874: "Puzzle",
    14875: "Typewriter",
    14876: "Transition",
    14877: "Lock",
    14878: "Boss",
    14879: "Mr Raccoon",
    14880: "Area Map",
    14881: "Key Item",
    14882: "Safe",
    14883: "Film",
    14884: "Weapon",
    14885: "Weapon Upgrade",
    14886: "Hip Pouch",
    14887: "File",
    14888: "Handgun Ammo",
    14890: "Grenade Rounds",
    14891: "SMG Ammo",
    14892: "Needle Cartridges",
    14895: "High-Powered Rounds",
    14897: "Ink Ribbon",
    14899: "Wooden Boards",
    14900: "Knife",
    14901: "Flash Grenade",
    14902: "Hand Grenade",
    14903: "Green Herb",
    14904: "Red Herb",
    14905: "Blue Herb",
    14906: "Gunpowder",
    14907: "High-Grade Gunpowder",
    14908: "First Aid Spray",
    14911: "Cassette Tape",
    14912: "Tape Player",
    14913: "Miscellaneous",
    14914: "Easter Egg",
    14915: "Window",
}

# Pixels per metre and the world position of Evil plan pixel (0, 0). Copied
# from tools/rpd_plan.py FLOORS; plan.json only carries the meshes.
FLOORS = {
    "1F": {"index": 0, "level": 0.0, "image": "1f", "size": (590, 413), "s": 6.63, "ox": 291.0, "oy": 240.0},
    "2F": {"index": 1, "level": 5.2, "image": "2f", "size": (561, 259), "s": 6.45, "ox": 262.0, "oy": 169.0},
    "3F": {"index": 2, "level": 10.4, "image": "3f", "size": (487, 259), "s": 6.78, "ox": 253.0, "oy": 176.0},
    "4F": {"index": 3, "level": 15.6, "image": "4f", "size": (100, 52), "s": 6.78, "ox": -136.8, "oy": 137.4},
    "B1": {"index": 4, "level": -5.2, "image": "b1", "size": (639, 337), "s": 6.45, "ox": 333.45, "oy": 0.65},
}

# z14 raster pixel -> Evil plan pixel. The first four are SIFT + RANSAC fits on
# Canny edges, and each records its inlier count and residual percentiles in
# Evil plan pixels. 4F is a hand fit on the room outline because the two 4F
# drawings stretch the stair band differently.
AFFINES = {
    "B1": (
        ((0.507558206350, 0.000761259996, -507.063738180669),
         (-0.000761259996, 0.507558206350, -316.368140495068)),
        {"method": "sift-canny-ransac", "matches": 66, "inliers": 28,
         "residual_px": {"median": 0.789, "p90": 1.487, "max": 1.948}},
    ),
    "1F": (
        ((0.503394043141, -0.000309765847, -472.874921158660),
         (0.000309765847, 0.503394043141, -826.094842789733)),
        {"method": "sift-canny-ransac", "matches": 96, "inliers": 31,
         "residual_px": {"median": 0.998, "p90": 2.070, "max": 3.028}},
    ),
    "2F": (
        ((0.500902768445, 0.000674151133, -499.575995280628),
         (-0.000674151133, 0.500902768445, -1397.555022027028)),
        {"method": "sift-canny-ransac", "matches": 92, "inliers": 25,
         "residual_px": {"median": 0.925, "p90": 1.703, "max": 2.198}},
    ),
    "3F": (
        ((0.501308236568, -0.000310325022, -498.908545528026),
         (0.000310325022, 0.501308236568, -1833.779111370796)),
        {"method": "sift-canny-ransac", "matches": 53, "inliers": 13,
         "residual_px": {"median": 0.491, "p90": 1.219, "max": 1.980}},
    ),
    "4F": (
        ((0.283582089552, 0.0, -299.067164179104),
         (0.0, 0.215686274510, -960.117647058824)),
        {"method": "manual-room-outline", "matches": 4, "inliers": 4,
         "residual_px": {"median": 0.0, "p90": 0.0, "max": 0.0}},
    ),
}

# z14 mosaic origin. Must match the tile range used for the SIFT fit.
ZOOM = 14
TILE_SIZE = 256
ORIGIN_X, ORIGIN_Y = 8134, 8157

# z14 mosaic rectangle the SIFT fit ran on, kept for the MapGenie-side overlay.
CROPS = {
    "B1": (650, 0, 2400, 1350),
    "1F": (700, 1500, 2400, 2500),
    "2F": (700, 2550, 2400, 3450),
    "3F": (700, 3450, 2250, 4300),
    "4F": (900, 4300, 1700, 4750),
}

XFORMULA = (
    "mx = ((lng + 180) / 360 * 2^14 - 8134) * 256; "
    "my = ((1 - asinh(tan(lat)) / pi) / 2 * 2^14 - 8157) * 256"
)
WORLD_FORMULA = "x = (plan_x - ox) / s; z = (plan_y - oy) / s; y = level"


def project(lng: float, lat: float) -> tuple[float, float]:
    """Web Mercator z14 pixel in the same mosaic the affines were fitted on."""
    n = 2 ** ZOOM
    tx = (lng + 180.0) / 360.0 * n
    ty = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return (tx - ORIGIN_X) * TILE_SIZE, (ty - ORIGIN_Y) * TILE_SIZE


def to_plan(floor: str, mx: float, my: float) -> tuple[float, float]:
    (a, b, c), (d, e, f) = AFFINES[floor][0]
    return a * mx + b * my + c, d * mx + e * my + f


def to_world(floor: str, px: float, py: float) -> tuple[float, float]:
    fl = FLOORS[floor]
    return (px - fl["ox"]) / fl["s"], (py - fl["oy"]) / fl["s"]


def floor_of(location: dict) -> str | None:
    lat = float(location["latitude"])
    lng = float(location["longitude"])
    if not (LNG_MIN <= lng <= LNG_MAX):
        return None
    for label, low, high in BANDS:
        if low <= lat < high:
            return label
    return None


def load_map(map_json: pathlib.Path | None) -> dict:
    if map_json is not None:
        return json.loads(map_json.read_text())
    request = urllib.request.Request(
        DATA_URL,
        headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
    )
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def box_flags(x: float, z: float, boxes: list[dict]) -> tuple[bool, bool, bool]:
    on_floor = on_door = on_stair = False
    for box in boxes:
        if box["x0"] <= x <= box["x1"] and box["z0"] <= z <= box["z1"]:
            colour = tuple(box["c"])
            if colour == (244, 242, 235):
                on_floor = True
            elif colour == (150, 150, 150):
                on_door = True
            elif colour in ((206, 202, 192), (52, 52, 52)):
                on_stair = True
    return on_floor, on_door, on_stair


def build(map_data: dict, plan: dict, nav: dict) -> dict:
    boxes = {floor["label"]: floor["boxes"] for floor in plan["floors"]}
    nodes = {}
    for floor in FLOORS:
        index = FLOORS[floor]["index"]
        nodes[floor] = [(n["x"], n["z"]) for n in nav["nodes"] if n["floor"] == index]

    items = []
    for location in map_data["locations"]:
        if location["id"] in EXCLUDED:
            continue
        floor = floor_of(location)
        if floor is None:
            continue
        lng = float(location["longitude"])
        lat = float(location["latitude"])
        mx, my = project(lng, lat)
        px, py = to_plan(floor, mx, my)
        x, z = to_world(floor, px, py)
        width, height = FLOORS[floor]["size"]
        inside = 0.0 <= px < width and 0.0 <= py < height
        on_floor, on_door, on_stair = box_flags(x, z, boxes[floor])
        nav_distance = min(
            (math.hypot(x - nx, z - nz) for nx, nz in nodes[floor]),
            default=float("inf"),
        )
        flags = []
        if not inside:
            flags.append("outside_plan_bounds")
        items.append({
            "id": location["id"],
            "title": location["title"],
            "category": CATEGORY_NAMES.get(location["category_id"], str(location["category_id"])),
            "category_id": location["category_id"],
            "floor": floor,
            "level": FLOORS[floor]["level"],
            "x": round(x, 3),
            "y": FLOORS[floor]["level"],
            "z": round(z, 3),
            "lat": lat,
            "lng": lng,
            "mapgenie_px": [round(mx, 2), round(my, 2)],
            "plan_px": [round(px, 2), round(py, 2)],
            "inside_plan_bounds": inside,
            "on_floor": on_floor,
            "on_door": on_door,
            "on_stair": on_stair,
            "nearest_nav": round(nav_distance, 2),
            "tags": location["tags"],
            "flags": flags,
        })

    counts = {label: 0 for label, _, _ in BANDS}
    for item in items:
        counts[item["floor"]] += 1
    outside = sum(1 for item in items if not item["inside_plan_bounds"])
    no_nav = sum(1 for item in items if item["nearest_nav"] > 2.0)
    not_on_mesh = sum(1 for item in items if not (item["on_floor"] or item["on_door"] or item["on_stair"]))

    floors = {}
    for label, _, _ in BANDS:
        (a, b, c), (d, e, f) = AFFINES[label][0]
        floors[label] = {
            "index": FLOORS[label]["index"],
            "level": FLOORS[label]["level"],
            "plan": f"tools/rpd_plans/{FLOORS[label]['image']}.png",
            "plan_size": list(FLOORS[label]["size"]),
            "calibration": {"s": FLOORS[label]["s"], "ox": FLOORS[label]["ox"], "oy": FLOORS[label]["oy"]},
            "mapgenie_crop_z14": list(CROPS[label]),
            "mapgenie_px_to_plan_px": [[a, b, c], [d, e, f], [0.0, 0.0, 1.0]],
            "fit": AFFINES[label][1],
        }

    return {
        "version": 1,
        "source": {
            "map_id": 878,
            "map_slug": "claire-a",
            "run": "Claire [A]",
            "difficulty": "Hardcore",
            "data_url": DATA_URL,
            "note": (
                "270 RPD markers. The data has no floor field; the floor comes from the "
                "latitude band of the stacked raster. The 14 Assisted/Standard-only ids are removed."
            ),
        },
        "projection": {
            "scheme": "web-mercator",
            "zoom": ZOOM,
            "tile_size": TILE_SIZE,
            "origin_tile": [ORIGIN_X, ORIGIN_Y],
            "mapgenie_px_formula": XFORMULA,
        },
        "world": {
            "formula": WORLD_FORMULA,
            "units": "metres",
            "y_is": "floor surface level, not the item mesh centre",
        },
        "floors": floors,
        "checks": {
            "counts": counts,
            "total": len(items),
            "outside_plan_bounds": outside,
            "no_nav_within_2m": no_nav,
            "not_on_floor_or_door_or_stair": not_on_mesh,
            "notes": {
                "on_floor": "A plan.json floor box contains the point. Wall and furniture items are false. The B1 garage and parts of 3F are also false because the floor mesh leaves them out.",
                "nearest_nav": "Distance to the nearest nav.json node on the same floor. Wall and furniture items are often more than 2 m from a node.",
            },
        },
        "items": items,
    }


def check(output: dict) -> None:
    expected = {"B1": 30, "1F": 112, "2F": 85, "3F": 40, "4F": 3}
    counts = output["checks"]["counts"]
    assert counts == expected, f"floor counts {counts} != {expected}"
    assert output["checks"]["total"] == 270, output["checks"]["total"]
    for item in output["items"]:
        assert item["inside_plan_bounds"], item["id"]
        assert math.isfinite(item["x"]) and math.isfinite(item["z"]), item["id"]
        assert item["y"] == item["level"], item["id"]
    samples = {
        544555: ("Spade Key", "3F"),
        544648: ("Diamond Key", "B1"),
        544635: ("Car Key", "B1"),
        545844: ("Car Trunk", "B1"),
        544408: ("Bolt Cutters", "1F"),
        544509: ("Lion Medallion", "2F"),
        545830: ("Clock Tower Puzzle", "3F"),
        544559: ("Small Gear", "4F"),
        544797: ("To 3F", "4F"),
        544402: ("Item Box", "1F"),
        544496: ("Diamond Door", "2F"),
    }
    by_id = {item["id"]: item for item in output["items"]}
    for marker_id, (title, floor) in samples.items():
        item = by_id[marker_id]
        assert item["title"] == title, (marker_id, item["title"])
        assert item["floor"] == floor, (marker_id, item["floor"])
        print(
            f"  {marker_id} {title:24} {floor:2} "
            f"({item['x']:8.3f}, {item['level']:5.1f}, {item['z']:8.3f}) "
            f"nav {item['nearest_nav']:.2f}m"
        )
    print("counts", counts)
    print("outside bounds", output["checks"]["outside_plan_bounds"])
    print("no nav within 2m", output["checks"]["no_nav_within_2m"])
    print("not on floor/door/stair", output["checks"]["not_on_floor_or_door_or_stair"])


def dumps(output: dict) -> str:
    """Pretty-print the metadata but keep each item on one line."""
    head = json.dumps({key: value for key, value in output.items() if key != "items"}, indent=2)
    body = ",\n".join(
        "    " + json.dumps(item, separators=(", ", ": ")) for item in output["items"]
    )
    return head[:-1] + ',\n  "items": [\n' + body + "\n  ]\n}\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map-json", type=pathlib.Path, help="saved API response; fetched when omitted")
    parser.add_argument("--out", type=pathlib.Path, default=OUT)
    parser.add_argument("--plan", type=pathlib.Path, default=PLAN)
    parser.add_argument("--nav", type=pathlib.Path, default=NAV)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    map_data = load_map(args.map_json)
    plan = json.loads(args.plan.read_text())
    nav = json.loads(args.nav.read_text())
    output = build(map_data, plan, nav)
    args.out.write_text(dumps(output))
    try:
        shown = args.out.relative_to(ROOT)
    except ValueError:
        shown = args.out
    print(f"wrote {shown} ({output['checks']['total']} items)")
    if args.check:
        check(output)


if __name__ == "__main__":
    main()
