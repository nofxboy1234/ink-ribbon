#!/usr/bin/env python3
"""Render matching source and blockout views from the saved blockout scene.

Run with ``blender -b build/rpd_blockout.blend -P tools/blockout_compare.py``.
"""
from __future__ import annotations

import math
import pathlib

import bpy
from mathutils import Vector

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "build/blockout/compare"
OUT.mkdir(parents=True, exist_ok=True)

VIEWS = [
    ("f1_main_hall", 1, (0.0, 1.8, 9.0), (0.0, 2.2, -8.0), 22),
    ("f1_west_office", 1, (-16.09, 1.7, -0.92), (-22.93, 1.9, -0.68), 24),
    ("f1_east_corridor", 1, (10.11, 1.8, 0.18), (34.64, 2.0, -0.35), 24),
    ("f1_press_room", 1, (21.45, 1.7, -11.53), (21.45, 1.9, -18.68), 22),
    ("f1_west_corridor", 1, (-24.81, 1.7, -13.25), (-22.74, 1.9, -25.45), 24),
    ("f2_west", 2, (-17.44, 7.0, -12.39), (-17.44, 7.2, 0.49), 24),
    ("f2_east", 2, (23.37, 6.9, -7.59), (25.98, 7.1, 6.67), 24),
    ("f2_west_407", 2, (-23.56, 7.0, 5.17), (-10.98, 7.2, 5.17), 24),
    ("f2_main_hall", 2, (0.0, 6.8, 9.0), (0.0, 6.8, -10.0), 22),
    ("f3_west", 3, (-30.71, 12.2, -9.24), (-30.65, 12.4, 4.27), 24),
    ("f3_east", 3, (13.0, 12.1, -4.0), (32.0, 12.1, -4.0), 24),
]


def blender_point(point):
    x, y, z = point
    return Vector((x, -z, y))


def make_camera(name, location, target, lens):
    cam = bpy.data.cameras.new(name)
    cam.lens = lens
    cam.clip_start = 0.05
    cam.clip_end = 400.0
    obj = bpy.data.objects.new(name, cam)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = blender_point(location)
    direction = blender_point(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return obj


def set_visibility(floor, blockout, source):
    for collection in bpy.data.collections:
        if collection.name in ("F1", "F2", "F3"):
            collection.hide_render = not (blockout and collection.name == f"F{floor}")
        elif collection.name.startswith("Ref_"):
            collection.hide_render = not (
                source and collection.name == f"Ref_F{floor}"
            )
    for obj in bpy.data.objects:
        if obj.name.startswith("Reference"):
            obj.hide_render = not source


def source_material():
    mat = bpy.data.materials.get("Source_Compare")
    if mat is None:
        mat = bpy.data.materials.new("Source_Compare")
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    if shader:
        shader.inputs["Base Color"].default_value = (0.52, 0.48, 0.42, 1.0)
        shader.inputs["Roughness"].default_value = 0.95
    mat.diffuse_color = (0.52, 0.48, 0.42, 1.0)
    return mat


def main():
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.studio_light = "paint.sl"
    shading.color_type = "MATERIAL"
    shading.show_shadows = True
    shading.show_cavity = True
    shading.cavity_type = "BOTH"
    shading.show_object_outline = False
    scene.render.resolution_x = 900
    scene.render.resolution_y = 600
    scene.render.image_settings.file_format = "PNG"
    source_mat = source_material()
    for obj in bpy.data.objects:
        if obj.name.startswith("Reference"):
            obj.data.materials.clear()
            obj.data.materials.append(source_mat)

    for name, floor, location, target, lens in VIEWS:
        camera = make_camera(name, location, target, lens)
        scene.camera = camera
        set_visibility(floor, blockout=True, source=False)
        scene.render.filepath = str(OUT / f"{name}_blockout.png")
        bpy.ops.render.render(write_still=True)
        set_visibility(floor, blockout=False, source=True)
        scene.render.filepath = str(OUT / f"{name}_source.png")
        bpy.ops.render.render(write_still=True)
        print(f"rendered {name}")


if __name__ == "__main__":
    main()
