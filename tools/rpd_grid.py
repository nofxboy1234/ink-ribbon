"""Sample walkable floor cells for the interactive RPD quest map.

Run with Blender after ``scene:import``. Writes ``public/rpd/grid.json`` with
one cell per square metre on each floor where the floor is flat, reachable
above head height, and clear of walls and props.
"""
from __future__ import annotations

import json
import math
import pathlib

import bpy
from mathutils import Vector

ROOT = pathlib.Path(__file__).resolve().parents[1]
BLEND = ROOT / "build" / "rpd.blend"
OUT = ROOT / "public" / "rpd" / "grid.json"

FLOORS = ((0, "1F", (0.0, 0.8)), (1, "2F", (5.2,)), (2, "3F", (10.4,)))
STEP = 1.0
X_RANGE = (-42.0, 46.0)
Z_RANGE = (-30.0, 22.0)


def blender_point(x: float, y: float, z: float) -> Vector:
    return Vector((x, -z, y))


def blender_dir(dx: float, dy: float, dz: float) -> Vector:
    return Vector((dx, -dz, dy)).normalized()


def hit(origin, direction, distance):
    return bpy.context.scene.ray_cast(
        bpy.context.evaluated_depsgraph_get(),
        origin,
        direction,
        distance=distance,
    )


def floor_at(x: float, z: float, level: float):
    found, loc, normal, _index, _obj, _matrix = hit(
        blender_point(x, level + 1.2, z), Vector((0.0, 0.0, -1.0)), 2.4
    )
    if not found or abs(loc.z - level) > 0.08:
        return False
    if normal.z < 0.82:
        return False
    return True


def clear(x: float, z: float, level: float) -> bool:
    # Headroom.
    found, loc, _n, _i, _o, _m = hit(
        blender_point(x, level + 0.12, z), Vector((0.0, 0.0, 1.0)), 1.7
    )
    if found:
        return False
    # Shoulder clearance in eight directions.
    for height in (0.45, 1.25):
        for i in range(8):
            angle = math.tau * i / 8.0
            direction = blender_dir(math.cos(angle), 0.0, math.sin(angle))
            found, _loc, _n, _i, _o, _m = hit(
                blender_point(x, level + height, z), direction, 0.46
            )
            if found:
                return False
    return True


def main() -> None:
    bpy.ops.wm.open_mainfile(filepath=str(BLEND))
    floors = []
    for index, label, levels in FLOORS:
        seen = set()
        cells = []
        for level in levels:
            x = X_RANGE[0]
            while x <= X_RANGE[1]:
                z = Z_RANGE[0]
                while z <= Z_RANGE[1]:
                    if floor_at(x, z, level) and clear(x, z, level):
                        key = (round(x, 2), round(z, 2), round(level, 2))
                        if key not in seen:
                            seen.add(key)
                            cells.append([round(x, 2), round(z, 2), round(level, 2)])
                    z += STEP
                x += STEP
        floors.append({"index": index, "level": min(levels), "label": label, "cells": cells})
        print(f"{label}: {len(cells)} cells", flush=True)
    OUT.write_text(json.dumps({"step": STEP, "floors": floors}, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}", flush=True)


if __name__ == "__main__":
    main()
