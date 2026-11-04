"""Assemble the walkable graph from sampled surface nodes.

Nodes are linked by short, shallow, line-of-sight edges. Leftover components
are joined with short portals, then each quest door's two room components are
bridged. Renumbering sorts nodes by position and rewrites every edge index.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path

from rpd_surface import portal_sees, sees
from rpd_world import floor_of

EDGE_RISE = 0.85
LINK_RADIUS = 1.45
LINK_BUCKET = 2.0
LINK_SLOPE = 0.85
STAIR_LINK_RADIUS = 1.15
STAIR_LINK_RISE = 0.55

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
        print(
            f"portal pass {_pass}: {len(comps)} components, {len(best)} pairs, "
            f"best span {min(v[0] for v in best.values()):.2f} m",
            flush=True,
        )
    return portals


def door_portals(nodes: list[dict], edges: set[tuple[int, int]], portals: list[list[int]], quest_path: Path):
    """Bridge each AP door's two room components, including doors whose threshold
    has no walkable cell because a fence or door leaf sits on it."""
    if not quest_path.exists():
        return
    quest = json.loads(quest_path.read_text(encoding="utf-8"))
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
        def door_distance(node) -> float:
            return (
                (node["x"] - door["x"]) ** 2
                + (node["y"] - door["y"]) ** 2
                + (node["z"] - door["z"]) ** 2
            )

        a = min(comps[from_comp], key=lambda i: door_distance(nodes[i]))
        b = min(comps[to_comp], key=lambda i: door_distance(nodes[i]))
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
