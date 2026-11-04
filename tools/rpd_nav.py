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
from collections import Counter

import bpy

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import rpd_blender as bl
from rpd_graph import bridge, components, door_portals, link, renumber
from rpd_surface import STAIR_DEDUPE, fine_stair_nodes, sample_column, stair_cells, surface_kind
from rpd_world import FLOORS, HALF, STEP, X_RANGE, Z_RANGE, floor_of

ROOT = pathlib.Path(__file__).resolve().parents[1]
BLEND = ROOT / "build" / "rpd.blend"
OUT = ROOT / "public" / "rpd" / "nav.json"
QUEST = ROOT / "public" / "rpd" / "quest.json"

MIN_NODES = 4000
MIN_EDGES = 3000


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
    started = time.time()
    bpy.ops.wm.open_mainfile(filepath=str(BLEND))
    bl.bind()

    nodes = scan()
    print(f"scanned {len(nodes)} nodes", flush=True)
    edges = link(nodes)
    portals = bridge(nodes, edges)
    door_portals(nodes, edges, portals, QUEST)
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
