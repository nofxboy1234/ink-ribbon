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
    # The hall views aim up the grand staircase at the 2F gallery.
    ("f1_main_hall", 1, (0.0, 2.60, 9.50), (0.0, 4.20, -16.40), 20),
    ("f1_hall_stairs", 1, (5.50, 2.20, 6.00), (-1.00, 3.20, -15.00), 22),
    ("f1_west_office", 1, (-19.64, 1.70, -2.52), (-9.74, 1.90, -2.52), 24),
    ("f1_east_corridor", 1, (11.05, 1.70, -6.17), (34.12, 1.90, -6.17), 24),
    ("f1_press_room", 1, (21.45, 1.70, -11.53), (21.45, 1.90, -18.18), 24),
    ("f1_west_corridor", 1, (-25.44, 1.70, -5.42), (-25.44, 1.90, -24.95), 24),
    ("f2_west", 2, (-17.59, 6.90, -9.75), (-17.59, 7.10, -0.01), 24),
    ("f2_east", 2, (26.90, 6.90, -16.12), (26.90, 7.10, 6.17), 24),
    ("f2_west_407", 2, (-23.38, 6.90, 3.08), (-17.89, 7.10, 3.08), 24),
    ("f2_main_hall", 2, (0.0, 6.60, 9.50), (0.0, 6.90, -14.00), 22),
    ("f3_west", 3, (-30.65, 12.10, -7.50), (-30.65, 12.30, -18.76), 24),
    ("f3_east", 3, (26.00, 12.10, -1.00), (26.00, 12.30, -12.60), 24),
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
