"""Blender scene access shared by the RPD samplers.

Source coordinates are metres with Y up. Blender is metres with Z up and
source +Z pointing along Blender -Y, so every sampler converts through
``point`` and ``direction`` instead of repeating the axis swap.
"""

from __future__ import annotations

import bpy
from mathutils import Vector

SCENE = None
DEPSGRAPH = None

DOWN = Vector((0.0, 0.0, -1.0))
UP = Vector((0.0, 0.0, 1.0))


def bind(scene=None, depsgraph=None) -> None:
    global SCENE, DEPSGRAPH
    SCENE = scene if scene is not None else bpy.context.scene
    DEPSGRAPH = depsgraph if depsgraph is not None else bpy.context.evaluated_depsgraph_get()


def point(x: float, y: float, z: float) -> Vector:
    return Vector((x, -z, y))


def direction(dx: float, dy: float, dz: float) -> Vector:
    return Vector((dx, -dz, dy)).normalized()


def cast(origin: Vector, direction: Vector, distance: float):
    return SCENE.ray_cast(DEPSGRAPH, origin, direction, distance=distance)


def material_name(obj, index: int) -> str:
    try:
        material = obj.data.materials[obj.data.polygons[index].material_index]
    except (AttributeError, IndexError, TypeError):
        return ""
    return material.name if material else ""
