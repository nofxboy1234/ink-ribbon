"""Shared loading and classification for the RPD blockout tools.

Source coordinates are the game's world space: X and Z horizontal, Y up,
in metres. The Blender scene converts to Z-up with ``to_blender``.
"""

from __future__ import annotations

import dataclasses
import pathlib
import struct

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "rpd"
BUILD = ROOT / "build" / "blockout"
SPEC = BUILD / "spec.json"
REFERENCE = BUILD / "reference"

FLOOR_OF_ROOM = {"1": 1, "2": 1, "3": 1, "4": 2, "5": 2, "6": 3}

# Vertical surfaces on this list are furniture, fittings or exterior scenery,
# not walls.
NON_WALL = (
    "ceil", "roof", "floor", "town", "asphalt", "ground", "wild", "rain",
    "decal", "border", "sign", "water", "dirt", "stain", "blood", "paper",
    "pipe", "duct", "cable", "wire", "fence", "railing", "curtain", "props",
    "desk", "table", "chair", "statue", "clock", "lift", "shutter", "barricade",
    "plant", "tree", "car", "debris", "trash", "book", "art", "picture",
    "bottle", "can", "snack", "electrical", "breaker", "tape", "sheet",
    "window", "door", "molding", "moulding", "vent", "lamp", "light",
)

# Horizontal surfaces on this list are not floor plates. Stair treads stay in
# the surface set so a flight can be fitted; they rarely form a floor peak.
NON_FLOOR = tuple(k for k in NON_WALL if k != "floor") + (
    "outwall",
    "counterwall",
    "arch",
)

# Horizontal surfaces that are the top of a structural element, not a floor.
NON_PLATE = (
    "pillar", "wall", "frame", "counter", "boiler", "sill", "ledge",
    "rail", "trim", "cornice", "beam", "ceiling", "molding", "moulding",
)

# Sky and backdrop materials, never part of the building.
OUTSIDE = ("town", "asphalt", "ground", "wild", "rain", "decal", "border", "build")


@dataclasses.dataclass(frozen=True)
class Batch:
    room: str
    floor: int
    material: str
    tris: np.ndarray


def material_names(data: bytes) -> list[str]:
    count = struct.unpack_from("<h", data, 0x12)[0]
    table = struct.unpack_from("<Q", data, 0x78)[0]
    offsets = struct.unpack_from(f"<{count}Q", data, table)
    return [data[o : data.index(b"\0", o)].decode("ascii", "ignore") for o in offsets]


def material_map(data: bytes) -> list[str]:
    mesh_offset = struct.unpack_from("<Q", data, 0x18)[0]
    count = data[mesh_offset + 1]
    remap_offset = struct.unpack_from("<Q", data, 0x60)[0]
    if remap_offset == 0:
        return material_names(data)
    remap = struct.unpack_from(f"<{count}H", data, remap_offset)
    names = material_names(data)
    return [names[i] if i < len(names) else f"material_{i}" for i in remap]


def _positions(mesh, group):
    import remesh

    return remesh.positions(mesh, group)


def _group_base(group):
    import remesh

    return remesh.group_vertex_base(group)


def load_rooms(raw: pathlib.Path = RAW) -> list[Batch]:
    import remesh

    batches: list[Batch] = []
    for path in sorted(raw.glob("*.mesh")):
        data = path.read_bytes()
        mesh = remesh.parse(data)
        names = material_map(data)
        floor = FLOOR_OF_ROOM[path.stem.split("_")[1][0]]
        for group in mesh.lods[0].groups:
            # Split the group's triangles by material so classification is
            # per material, not per group.
            pos = np.asarray(_positions(mesh, group), dtype=np.float32)
            base = _group_base(group)
            size = 4 if mesh.has_32bit_indices else 2
            dtype = np.uint32 if size == 4 else np.uint16
            for sub in group.submeshes:
                if sub.is_quad or sub.index_count == 0:
                    continue
                raw = np.frombuffer(
                    mesh.index_buffer,
                    dtype=dtype,
                    count=sub.index_count,
                    offset=sub.index_start * size,
                ).reshape(-1, 3).astype(np.int64)
                raw += sub.vertex_start - base
                batches.append(
                    Batch(path.stem, floor, names[sub.material], pos[raw])
                )
    return batches


def join_band(batches: list[Batch]) -> tuple[np.ndarray, np.ndarray]:
    """Return every triangle, ignoring the room's nominal floor."""
    if not batches:
        return np.zeros((0, 3, 3), np.float32), np.zeros(0, dtype=object)
    tris = np.concatenate([b.tris for b in batches])
    names = np.concatenate(
        [np.full(len(b.tris), b.material, dtype=object) for b in batches]
    )
    return tris, names


def join(batches: list[Batch], floor: int) -> tuple[np.ndarray, np.ndarray]:
    """Return (triangles, material names) for one floor."""
    picked = [b for b in batches if b.floor == floor]
    if not picked:
        return np.zeros((0, 3, 3), np.float32), np.zeros(0, dtype=object)
    tris = np.concatenate([b.tris for b in picked])
    names = np.concatenate(
        [np.full(len(b.tris), b.material, dtype=object) for b in picked]
    )
    return tris, names


def is_outside(material: str) -> bool:
    low = material.lower()
    return any(k in low for k in OUTSIDE)


def is_wall_material(material: str) -> bool:
    low = material.lower()
    if "stair" in low:
        return False
    if any(k in low for k in ("townpolice00", "townpolice01", "townpolice00noshadow")):
        return True
    if is_outside(low):
        return False
    return not any(k in low for k in NON_WALL)


def is_floor_material(material: str, include_stairs: bool = False) -> bool:
    low = material.lower()
    # The forecourt staircase is tagged as exterior ground, but it is the only
    # way in and out of the building.
    if "townstairs" in low:
        return include_stairs
    if is_outside(low):
        return False
    if "stairsfloor" in low:
        return True
    bad = NON_FLOOR if include_stairs else NON_FLOOR + ("stair",)
    if any(k in low for k in bad):
        return False
    return not any(k in low for k in NON_PLATE)


def to_blender(x: float, y: float, z: float) -> tuple[float, float, float]:
    return (x, -z, y)


def bounds(tris: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    p = tris.reshape(-1, 3)
    return p.min(axis=0), p.max(axis=0)
