"""Walkable surface sampling and visibility over the loaded Blender scene.

The domain is the set of up-facing, walkable surfaces on each 1 m cell. A
column is swept downward for surface hits, each hit is tested for headroom and
shoulder clearance, and stairs get a finer sweep so every tread keeps its own
height.
"""

from __future__ import annotations

import math
from functools import lru_cache

import rpd_blender as bl
from rpd_blender import DOWN, UP
from rpd_world import HALF, STEP, X_RANGE, Z_RANGE

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

LOS_HEIGHT = 0.55
LOS_SLACK = 0.18

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


def cast_ignoring(origin: Vector, direction: Vector, distance: float):
    """Nearest hit that is not see-through, as (location, material_name)."""
    start = origin.copy()
    left = distance
    for _ in range(6):
        found, location, _normal, index, obj, _matrix = bl.cast(start, direction, left)
        if not found:
            return None
        name = bl.material_name(obj, index)
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
        found, location, _normal, index, obj, _matrix = bl.cast(start, direction, left)
        if not found:
            return None
        name = bl.material_name(obj, index)
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
    origin = bl.point(a["x"], a["y"] + LOS_HEIGHT, a["z"])
    blocked = cast_portal(origin, bl.direction(dx, dy, dz), span)
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
    if cast_ignoring(bl.point(x, y + HEADROOM_LIFT, z), UP, headroom):
        return False
    for height in SHOULDER_HEIGHTS:
        origin = bl.point(x, y + height, z)
        for step in range(SHOULDER_STEPS):
            angle = math.tau * step / SHOULDER_STEPS
            direction = bl.direction(math.cos(angle), 0.0, math.sin(angle))
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
        found, location, normal, index, obj, _matrix = bl.cast(bl.point(x, y, z), DOWN, y - LOWEST)
        if not found:
            break
        height = location.z
        name = bl.material_name(obj, index)
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


def sees(a: dict, b: dict) -> bool:
    dx = b["x"] - a["x"]
    dy = b["y"] - a["y"]
    dz = b["z"] - a["z"]
    span = math.sqrt(dx * dx + dy * dy + dz * dz)
    if span < 1e-3:
        return False
    origin = bl.point(a["x"], a["y"] + LOS_HEIGHT, a["z"])
    blocked = cast_ignoring(origin, bl.direction(dx, dy, dz), span)
    if blocked is None:
        return True
    return (blocked[0] - origin).length > span - LOS_SLACK


def stair_cells() -> set[tuple[float, float]]:
    """1 m cells touched by an up-facing stair tread, including curved flights
    whose treads never land on the cell centre."""
    cells: set[tuple[float, float]] = set()
    for obj in bl.SCENE.objects:
        if obj.type != "MESH":
            continue
        evaluated = obj.evaluated_get(bl.DEPSGRAPH)
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
