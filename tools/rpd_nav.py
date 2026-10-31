"""Build the RPD navigation graph.

A walkable surface graph for ``public/rpd/nav.json``. Every node sits at the
centre of a 1 m cell on a real surface, so stair treads and ramps get nodes at
their own heights instead of being flattened onto a floor level.

The scene is scanned with ``bpy.context.scene.ray_cast``. Each 1 m column is
swept downward for up-facing hits, filtered by material, headroom and shoulder
clearance, then linked to nearby nodes within 1.45 m and finally bridged into
one component by short line-of-sight portals.

Run after ``scene:import`` with ``blender -b -P tools/rpd_nav.py``.
"""
from __future__ import annotations

import json
import math
import pathlib
import sys
import time
from collections import Counter, defaultdict
from functools import lru_cache

import bpy
from mathutils import Vector

ROOT = pathlib.Path(__file__).resolve().parents[1]
BLEND = ROOT / "build" / "rpd.blend"
OUT = ROOT / "public" / "rpd" / "nav.json"
QUEST = ROOT / "public" / "rpd" / "quest.json"

STEP = 1.0
HALF = 0.5
X_RANGE = (-42.0, 46.0)
Z_RANGE = (-30.0, 22.0)

CEILING = 16.0
LOWEST = -1.0
MAX_HITS = 12
MIN_NORMAL_Z = 0.72
RAMP_NORMAL_Z = 0.95
SURFACE_MERGE = 0.06
DECAL_STEP = 0.005

HEADROOM = 1.75
HEADROOM_LIFT = 0.12
SHOULDER = 0.30
SHOULDER_HEIGHTS = (0.45, 1.25)
SHOULDER_STEPS = 8

# Stairs are narrower than a room and often have a handrail or the flight above
# close to the tread, so sample them with a tighter body and less headroom.
STAIR_STEP = 0.25
STAIR_SHOULDER = 0.16
STAIR_HEADROOM = 1.45
STAIR_DEDUPE = 0.30

EDGE_RISE = 0.85
LINK_RADIUS = 1.45
LINK_BUCKET = 2.0
LINK_SLOPE = 0.85
STAIR_LINK_RADIUS = 1.15
STAIR_LINK_RISE = 0.55
LOS_HEIGHT = 0.55
LOS_SLACK = 0.18

# Portals are only for real gaps (door thresholds, missing cells, the last step
# onto a stair landing). A long portal is a straight line through the air, so
# keep them short and shallow.
PORTAL_SPAN = 2.3
PORTAL_RISE = 0.9
PORTAL_SLOPE = 0.6
PORTAL_PASSES = 24
PORTAL_BUCKET = 2.0
DOOR_PORTAL_SPAN = 3.5
DOOR_PORTAL_RISE = 2.0

MIN_NODES = 4000
MIN_EDGES = 3000

FLOORS = ((0, "1F", 0.0), (1, "2F", 5.2), (2, "3F", 10.4))

WALKABLE_KEYS = ("floor", "stair", "ground", "ramp", "carpet", "asphalt")
BLOCKED_KEYS = (
    "wall",
    "ceiling",
    "roof",
    "door",
    "fence",
    "rail",
    "pillar",
    "desk",
    "counter",
    "shelf",
    "statue",
    "glass",
    "window",
    "dirt",
    "blood",
    "paper",
    "decal",
    "prop",
    "sign",
    "shutter",
    "frame",
    "lamp",
    "pipe",
    "cable",
)
CLEAR_KEYS = ("door", "frame", "decal", "dirt", "blood", "paper", "stain", "water", "sign", "poster")
STAIR_KEYS = ("stair", "step")

DOWN = Vector((0.0, 0.0, -1.0))
UP = Vector((0.0, 0.0, 1.0))

SCENE = None
DEPSGRAPH = None


def blender_point(x: float, y: float, z: float) -> Vector:
    """Scene metres (y up) to Blender metres (z up)."""
    return Vector((x, -z, y))


def blender_dir(dx: float, dy: float, dz: float) -> Vector:
    return Vector((dx, -dz, dy)).normalized()


def cast(origin: Vector, direction: Vector, distance: float):
    return SCENE.ray_cast(DEPSGRAPH, origin, direction, distance=distance)


@lru_cache(maxsize=None)
def walkable(name: str) -> bool:
    key = name.lower()
    if not any(k in key for k in WALKABLE_KEYS):
        return False
    return not any(k in key for k in BLOCKED_KEYS)


@lru_cache(maxsize=None)
def transparent(name: str) -> bool:
    key = name.lower()
    return any(k in key for k in CLEAR_KEYS)


@lru_cache(maxsize=None)
def surface_kind(name: str, normal_z: float) -> str:
    key = name.lower()
    if any(k in key for k in STAIR_KEYS):
        return "stair"
    return "ramp" if normal_z < RAMP_NORMAL_Z else "floor"


def material_name(obj, index: int) -> str:
    try:
        material = obj.data.materials[obj.data.polygons[index].material_index]
    except (AttributeError, IndexError, TypeError):
        return ""
    return material.name if material else ""


def cast_ignoring(origin: Vector, direction: Vector, distance: float):
    """Nearest hit that is not see-through, as (location, material_name)."""
    start = origin.copy()
    left = distance
    for _ in range(6):
        found, location, _normal, index, obj, _matrix = cast(start, direction, left)
        if not found:
            return None
        name = material_name(obj, index)
        if not transparent(name):
            return location, name
        left -= (location - start).length + 0.03
        if left <= 0.01:
            return None
        start = location + direction * 0.03
    return None


def cast_portal(origin: Vector, direction: Vector, distance: float):
    """Line of sight for a portal. Steps and floors are passable; walls and props are not."""
    start = origin.copy()
    left = distance
    for _ in range(8):
        found, location, _normal, index, obj, _matrix = cast(start, direction, left)
        if not found:
            return None
        name = material_name(obj, index)
        if not transparent(name) and not walkable(name):
            return location, name
        left -= (location - start).length + 0.03
        if left <= 0.01:
            return None
        start = location + direction * 0.03
    return None


def portal_sees(a: dict, b: dict) -> bool:
    dx = b["x"] - a["x"]
    dy = b["y"] - a["y"]
    dz = b["z"] - a["z"]
    span = math.sqrt(dx * dx + dy * dy + dz * dz)
    if span < 1e-3:
        return False
    origin = blender_point(a["x"], a["y"] + LOS_HEIGHT, a["z"])
    blocked = cast_portal(origin, blender_dir(dx, dy, dz), span)
    if blocked is None:
        return True
    return (blocked[0] - origin).length > span - LOS_SLACK


def clear(
    x: float,
    y: float,
    z: float,
    shoulder: float = SHOULDER,
    headroom: float = HEADROOM,
) -> bool:
    if cast_ignoring(blender_point(x, y + HEADROOM_LIFT, z), UP, headroom):
        return False
    for height in SHOULDER_HEIGHTS:
        origin = blender_point(x, y + height, z)
        for step in range(SHOULDER_STEPS):
            angle = math.tau * step / SHOULDER_STEPS
            direction = blender_dir(math.cos(angle), 0.0, math.sin(angle))
            if cast_ignoring(origin, direction, shoulder):
                return False
    return True


SUBCELL_OFFSETS = ((0.3, 0.0), (-0.3, 0.0), (0.0, 0.3), (0.0, -0.3))


def sample_column(
    x: float,
    z: float,
    shoulder: float = SHOULDER,
    headroom: float = HEADROOM,
    fallback: bool = True,
) -> list[tuple[float, str, float]]:
    surfaces: list[tuple[float, str, float]] = []
    y = CEILING
    for _ in range(MAX_HITS):
        if y <= LOWEST:
            break
        found, location, normal, index, obj, _matrix = cast(blender_point(x, y, z), DOWN, y - LOWEST)
        if not found:
            break
        height = location.z
        name = material_name(obj, index)
        y = height - (DECAL_STEP if transparent(name) else SURFACE_MERGE)
        if normal.z <= MIN_NORMAL_Z or not walkable(name):
            continue
        if any(abs(height - other[0]) < SURFACE_MERGE for other in surfaces):
            continue
        if not clear(x, height, z, shoulder, headroom):
            continue
        surfaces.append((height, name, normal.z))
    if not surfaces and fallback:
        # A cell centre can land on a thin sliver whose normal is skewed (a
        # ground seam, a stair nosing). Probe just off centre for the real
        # surface, but keep the node on the lattice so the selection square
        # still matches the cell.
        for ox, oz in SUBCELL_OFFSETS:
            for height, name, normal_z in sample_column(x + ox, z + oz, shoulder, headroom, False):
                if clear(x, height, z, shoulder, headroom):
                    surfaces.append((height, name, normal_z))
                    break
            if surfaces:
                break
    return surfaces


def floor_of(y: float) -> int:
    return min(range(len(FLOORS)), key=lambda index: (abs(FLOORS[index][2] - y), index))


def sees(a: dict, b: dict) -> bool:
    dx = b["x"] - a["x"]
    dy = b["y"] - a["y"]
    dz = b["z"] - a["z"]
    span = math.sqrt(dx * dx + dy * dy + dz * dz)
    if span < 1e-3:
        return False
    origin = blender_point(a["x"], a["y"] + LOS_HEIGHT, a["z"])
    blocked = cast_ignoring(origin, blender_dir(dx, dy, dz), span)
    if blocked is None:
        return True
    return (blocked[0] - origin).length > span - LOS_SLACK


def stair_cells() -> set[tuple[float, float]]:
    """1 m cells touched by an up-facing stair tread, including curved flights
    whose treads never land on the cell centre."""
    cells: set[tuple[float, float]] = set()
    for obj in SCENE.objects:
        if obj.type != "MESH":
            continue
        evaluated = obj.evaluated_get(DEPSGRAPH)
        mesh = evaluated.to_mesh()
        matrix = obj.matrix_world
        normal_matrix = matrix.to_3x3()
        for polygon in mesh.polygons:
            try:
                material = mesh.materials[polygon.material_index]
            except (AttributeError, IndexError, TypeError):
                continue
            if material is None:
                continue
            name = material.name
            if not any(key in name.lower() for key in STAIR_KEYS):
                continue
            normal = (normal_matrix @ polygon.normal).normalized()
            if normal.z <= MIN_NORMAL_Z:
                continue
            xs: list[float] = []
            zs: list[float] = []
            for vertex_index in polygon.vertices:
                vertex = matrix @ mesh.vertices[vertex_index].co
                xs.append(vertex.x)
                zs.append(-vertex.y)
            if not xs:
                continue
            x0 = max(X_RANGE[0], math.floor((min(xs) - HALF) / STEP) * STEP)
            x1 = min(X_RANGE[1], math.ceil((max(xs) + HALF) / STEP) * STEP)
            z0 = max(Z_RANGE[0], math.floor((min(zs) - HALF) / STEP) * STEP)
            z1 = min(Z_RANGE[1], math.ceil((max(zs) + HALF) / STEP) * STEP)
            x = x0
            while x <= x1 + 1e-6:
                z = z0
                while z <= z1 + 1e-6:
                    cells.add((round(x, 2), round(z, 2)))
                    z += STEP
                x += STEP
        evaluated.to_mesh_clear()
    return cells


def fine_stair_nodes(cells: set[tuple[float, float]]) -> list[tuple[float, float, float, str]]:
    """Probe each stair cell on a fine grid and keep one node per surface height.

    The node stays on the 1 m lattice so the selection square still matches the
    cell; only its height comes from the sub-cell sample nearest the centre.
    """
    found: list[tuple[float, float, float, str]] = []
    steps = int(round(STEP / STAIR_STEP))
    for cx, cz in sorted(cells):
        heights: list[dict] = []
        for ix in range(steps + 1):
            x = cx - HALF + ix * STAIR_STEP
            for iz in range(steps + 1):
                z = cz - HALF + iz * STAIR_STEP
                distance = (x - cx) ** 2 + (z - cz) ** 2
                for height, name, normal_z in sample_column(x, z, STAIR_SHOULDER, STAIR_HEADROOM):
                    kind = surface_kind(name, normal_z)
                    if kind not in ("stair", "ramp"):
                        continue
                    for entry in heights:
                        if abs(entry["y"] - height) < 0.18:
                            if distance < entry["distance"]:
                                entry.update(y=height, distance=distance, kind=kind)
                            break
                    else:
                        heights.append({"y": height, "distance": distance, "kind": kind})
        for entry in heights:
            found.append((cx, entry["y"], cz, entry["kind"]))
    return found


def scan() -> list[dict]:
    nodes: list[dict] = []
    x = X_RANGE[0]
    while x <= X_RANGE[1] + 1e-6:
        z = Z_RANGE[0]
        while z <= Z_RANGE[1] + 1e-6:
            for height, name, normal_z in sample_column(x, z):
                nodes.append(
                    {
                        "x": x,
                        "y": height,
                        "z": z,
                        "kind": surface_kind(name, normal_z),
                        "n": [],
                    }
                )
            z += STEP
        x += STEP

    cells = stair_cells()
    added = 0
    for x, height, z, kind in fine_stair_nodes(cells):
        duplicate = False
        for node in nodes:
            if (
                abs(node["x"] - x) < STAIR_DEDUPE
                and abs(node["z"] - z) < STAIR_DEDUPE
                and abs(node["y"] - height) < STAIR_DEDUPE
            ):
                duplicate = True
                break
        if duplicate:
            continue
        nodes.append({"x": x, "y": height, "z": z, "kind": kind, "n": []})
        added += 1
    print(f"stair cells: {len(cells)}, fine stair/ramp nodes: {added}", flush=True)
    return nodes


def link(nodes: list[dict]) -> set[tuple[int, int]]:
    """Link nearby nodes, including diagonals and door thresholds.

    A 4-neighbour grid breaks at offset doorways and curved stairs, so use a
    short radius and let line of sight reject walls.
    """
    edges: set[tuple[int, int]] = set()
    buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
    for index, node in enumerate(nodes):
        buckets[(int(math.floor(node["x"] / LINK_BUCKET)), int(math.floor(node["z"] / LINK_BUCKET)))].append(index)
    for a, na in enumerate(nodes):
        bucket_x = int(math.floor(na["x"] / LINK_BUCKET))
        bucket_z = int(math.floor(na["z"] / LINK_BUCKET))
        for gx in range(bucket_x - 1, bucket_x + 2):
            for gz in range(bucket_z - 1, bucket_z + 2):
                for b in buckets[(gx, gz)]:
                    if b <= a:
                        continue
                    nb = nodes[b]
                    rise = nb["y"] - na["y"]
                    horizontal = math.hypot(nb["x"] - na["x"], nb["z"] - na["z"])
                    if horizontal > LINK_RADIUS or abs(rise) > EDGE_RISE:
                        continue
                    if abs(rise) > LINK_SLOPE * max(horizontal, 0.25):
                        continue
                    if not sees(na, nb):
                        stair = na["kind"] in ("stair", "ramp") or nb["kind"] in ("stair", "ramp")
                        if not (
                            stair
                            and horizontal <= STAIR_LINK_RADIUS
                            and abs(rise) <= STAIR_LINK_RISE
                            and portal_sees(na, nb)
                        ):
                            continue
                    na["n"].append(b)
                    nb["n"].append(a)
                    edges.add((a, b) if a < b else (b, a))
    return edges


def components(nodes: list[dict]) -> list[list[int]]:
    seen = [False] * len(nodes)
    comps: list[list[int]] = []
    for start in range(len(nodes)):
        if seen[start]:
            continue
        seen[start] = True
        stack = [start]
        comp = []
        while stack:
            current = stack.pop()
            comp.append(current)
            for other in nodes[current]["n"]:
                if not seen[other]:
                    seen[other] = True
                    stack.append(other)
        comps.append(comp)
    return comps


def bridge(nodes: list[dict], edges: set[tuple[int, int]]) -> list[list[int]]:
    """Join leftover components with the shortest clear node pair between each pair."""
    buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
    for index, node in enumerate(nodes):
        buckets[(int(math.floor(node["x"] / PORTAL_BUCKET)), int(math.floor(node["z"] / PORTAL_BUCKET)))].append(index)
    portals: list[list[int]] = []
    for _pass in range(PORTAL_PASSES):
        comps = components(nodes)
        if len(comps) <= 1:
            break
        owner = [0] * len(nodes)
        for index, comp in enumerate(comps):
            for node in comp:
                owner[node] = index
        best: dict[tuple[int, int], tuple[float, int, int]] = {}
        for a, na in enumerate(nodes):
            bucket_x = int(math.floor(na["x"] / PORTAL_BUCKET))
            bucket_z = int(math.floor(na["z"] / PORTAL_BUCKET))
            for gx in range(bucket_x - 1, bucket_x + 2):
                for gz in range(bucket_z - 1, bucket_z + 2):
                    for b in buckets[(gx, gz)]:
                        if b <= a:
                            continue
                        owner_a = owner[a]
                        owner_b = owner[b]
                        if owner_a == owner_b:
                            continue
                        nb = nodes[b]
                        rise = nb["y"] - na["y"]
                        horizontal = math.hypot(nb["x"] - na["x"], nb["z"] - na["z"])
                        if abs(rise) > PORTAL_RISE:
                            continue
                        if abs(rise) > PORTAL_SLOPE * max(horizontal, 0.2):
                            continue
                        span = math.sqrt(horizontal * horizontal + rise * rise)
                        if span > PORTAL_SPAN:
                            continue
                        key = (owner_a, owner_b) if owner_a < owner_b else (owner_b, owner_a)
                        previous = best.get(key)
                        if previous is not None and previous[0] <= span:
                            continue
                        if not portal_sees(na, nb):
                            continue
                        best[key] = (span, a, b)
        if not best:
            break
        for span, a, b in best.values():
            pair = (a, b) if a < b else (b, a)
            if pair in edges:
                continue
            edges.add(pair)
            nodes[a]["n"].append(b)
            nodes[b]["n"].append(a)
            portals.append([pair[0], pair[1]])
        print(f"portal pass {_pass}: {len(comps)} components, {len(best)} pairs, best span {min(v[0] for v in best.values()):.2f} m", flush=True)
    return portals


def door_portals(nodes: list[dict], edges: set[tuple[int, int]], portals: list[list[int]]):
    """Bridge each AP door's two room components, including doors whose threshold
    has no walkable cell because a fence or door leaf sits on it."""
    if not QUEST.exists():
        return
    quest = json.loads(QUEST.read_text(encoding="utf-8"))
    rooms = {room["name"]: room for room in quest.get("rooms", [])}
    comps = components(nodes)
    owner = [0] * len(nodes)
    for index, comp in enumerate(comps):
        for node in comp:
            owner[node] = index
    nearest = {}

    def nearest_to(point):
        key = (round(point[0], 2), round(point[2], 2))
        if key in nearest:
            return nearest[key]
        best = -1
        best_distance = float("inf")
        for index, node in enumerate(nodes):
            distance = (node["x"] - point[0]) ** 2 + (node["z"] - point[2]) ** 2 + (node["y"] - point[1]) ** 2
            if distance < best_distance:
                best_distance = distance
                best = index
        nearest[key] = best
        return best

    for door in quest.get("doors", []):
        from_room = rooms.get(door["from"])
        to_room = rooms.get(door["to"])
        if not from_room or not to_room:
            continue
        from_seed = nearest_to((from_room["x"], from_room["level"], from_room["z"]))
        to_seed = nearest_to((to_room["x"], to_room["level"], to_room["z"]))
        if from_seed < 0 or to_seed < 0:
            continue
        from_comp = owner[from_seed]
        to_comp = owner[to_seed]
        if from_comp == to_comp:
            continue
        a = min((i for i in comps[from_comp]), key=lambda i: (nodes[i]["x"] - door["x"]) ** 2 + (nodes[i]["y"] - door["y"]) ** 2 + (nodes[i]["z"] - door["z"]) ** 2)
        b = min((i for i in comps[to_comp]), key=lambda i: (nodes[i]["x"] - door["x"]) ** 2 + (nodes[i]["y"] - door["y"]) ** 2 + (nodes[i]["z"] - door["z"]) ** 2)
        span = math.dist((nodes[a]["x"], nodes[a]["y"], nodes[a]["z"]), (nodes[b]["x"], nodes[b]["y"], nodes[b]["z"]))
        rise = abs(nodes[a]["y"] - nodes[b]["y"])
        if span > DOOR_PORTAL_SPAN or rise > DOOR_PORTAL_RISE:
            print(f"door portal {door['id']}: skipped {span:.1f} m / {rise:.1f} m rise", flush=True)
            continue
        pair = (a, b) if a < b else (b, a)
        if pair in edges:
            continue
        edges.add(pair)
        nodes[a]["n"].append(b)
        nodes[b]["n"].append(a)
        portals.append([pair[0], pair[1], door["id"]])
        print(f"door portal {door['id']}: {door['from']} <-> {door['to']} span {span:.1f} m", flush=True)


def renumber(nodes: list[dict], portals: list[list[int]]):
    order = sorted(range(len(nodes)), key=lambda i: (nodes[i]["x"], nodes[i]["z"], nodes[i]["y"]))
    new_of = [0] * len(nodes)
    for new, old in enumerate(order):
        new_of[old] = new
    out = []
    for old in order:
        node = nodes[old]
        height = round(node["y"], 3)
        out.append(
            {
                "x": round(node["x"], 2),
                "y": height,
                "z": round(node["z"], 2),
                "floor": floor_of(height),
                "kind": node["kind"],
                "n": sorted({new_of[other] for other in node["n"]}),
            }
        )
    out_portals = []
    for portal in portals:
        a, b = new_of[portal[0]], new_of[portal[1]]
        pair = [a, b] if a < b else [b, a]
        if len(portal) > 2:
            pair.append(portal[2])
        out_portals.append(pair)
    out_portals.sort(key=lambda item: (item[0], item[1], item[2] if len(item) > 2 else ""))
    return out, out_portals


def reachability(nodes: list[dict]) -> dict:
    comps = components(nodes)
    if not comps:
        return {"largest": 0, "rooms_bad": [], "items_bad": []}
    largest = max(comps, key=len)
    members = set(largest)
    rooms_bad = []
    items_bad = []
    if QUEST.exists():
        quest = json.loads(QUEST.read_text(encoding="utf-8"))
        for room in quest.get("rooms", []):
            best = min(
                math.dist((nodes[i]["x"], nodes[i]["y"], nodes[i]["z"]), (room["x"], room["level"], room["z"]))
                for i in members
            )
            if best > 3.0:
                rooms_bad.append((room["name"], round(best, 2)))
        for item in quest.get("items", []):
            target = (item["x"], item["y"] - 0.36, item["z"])
            best = min(
                math.dist((nodes[i]["x"], nodes[i]["y"], nodes[i]["z"]), target)
                for i in members
            )
            if best > 3.5:
                items_bad.append((item["name"], item["region"], round(best, 2)))
    return {"largest": len(largest), "rooms_bad": rooms_bad, "items_bad": items_bad}


def report(nodes: list[dict], edges: int, portals: list[list[int]], started: float) -> None:
    comps = components(nodes)
    sizes = sorted((len(comp) for comp in comps), reverse=True)
    floors = Counter(node["floor"] for node in nodes)
    kinds = Counter(node["kind"] for node in nodes)
    low_stairs = sum(1 for node in nodes if 1.0 < node["y"] < 5.1)
    high_stairs = sum(1 for node in nodes if 6.0 < node["y"] < 10.3)
    print(f"nodes: {len(nodes)}", flush=True)
    print(f"edges: {edges}", flush=True)
    print(f"portals: {len(portals)}", flush=True)
    print(f"components: {len(comps)}", flush=True)
    print(f"largest component: {sizes[0]}", flush=True)
    print(f"component sizes: {sizes[:10]}", flush=True)
    for index, label, _level in FLOORS:
        print(f"floor {label}: {floors[index]} nodes", flush=True)
    for kind in ("floor", "stair", "ramp"):
        print(f"kind {kind}: {kinds[kind]}", flush=True)
    print(f"y 1.0-5.1: {low_stairs}  y 6.0-10.3: {high_stairs}", flush=True)
    reach = reachability(nodes)
    print(f"reachable largest: {reach['largest']}", flush=True)
    print(f"rooms outside largest: {len(reach['rooms_bad'])} {reach['rooms_bad'][:5]}", flush=True)
    print(f"items outside largest: {len(reach['items_bad'])} {reach['items_bad'][:5]}", flush=True)
    print(f"time: {time.time() - started:.1f}s", flush=True)


def main() -> int:
    global SCENE, DEPSGRAPH
    started = time.time()
    bpy.ops.wm.open_mainfile(filepath=str(BLEND))
    SCENE = bpy.context.scene
    DEPSGRAPH = bpy.context.evaluated_depsgraph_get()

    nodes = scan()
    print(f"scanned {len(nodes)} nodes", flush=True)
    edges = link(nodes)
    portals = bridge(nodes, edges)
    door_portals(nodes, edges, portals)
    nodes, portals = renumber(nodes, portals)

    report(nodes, len(edges), portals, started)

    payload = {
        "version": 1,
        "step": STEP,
        "half": HALF,
        "floors": [{"index": index, "label": label, "level": level} for index, label, level in FLOORS],
        "nodes": nodes,
        "portals": portals,
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.0f} KiB)", flush=True)

    if len(nodes) < MIN_NODES or len(edges) < MIN_EDGES:
        print(f"FAIL: {len(nodes)} nodes and {len(edges)} edges, expected at least {MIN_NODES} and {MIN_EDGES}", flush=True)
        return 1
    reach = reachability(nodes)
    if reach["rooms_bad"] or reach["items_bad"]:
        print(f"FAIL: {len(reach['rooms_bad'])} rooms and {len(reach['items_bad'])} items outside the largest component", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
