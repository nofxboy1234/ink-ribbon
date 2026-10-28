#!/usr/bin/env python3
"""Assemble the RPD blockout scene in Blender from ``build/blockout/spec.json``.

Run with ``blender -b -P tools/blockout_scene.py``. The source geometry is
imported as a ghosted reference in the same world space as the blockout.
"""

from __future__ import annotations

import argparse
import json
import math
import pathlib
import sys

import bmesh
import bpy
from mathutils import Vector
from mathutils.geometry import tessellate_polygon

ROOT = pathlib.Path(__file__).resolve().parents[1]
BUILD = ROOT / "build" / "blockout"
SPEC = BUILD / "spec.json"
REFERENCE = BUILD / "reference"
BLEND = ROOT / "build" / "rpd_blockout.blend"
RENDERS = BUILD / "renders"

HALF_WALL_HEIGHT = 0.95

# Stairs carry a warm tint so circulation reads at a glance against the
# neutral floors and walls.
FLOOR_COLOURS = {
    "floor": (0.62, 0.63, 0.61, 1.0),
    "wall": (0.29, 0.30, 0.31, 1.0),
    "pillar": (0.46, 0.47, 0.46, 1.0),
    "stair": (0.72, 0.50, 0.30, 1.0),
    "ramp": (0.72, 0.50, 0.30, 1.0),
}


def blender_point(x, y, z):
    return Vector((float(x), -float(z), float(y)))


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def material(name, colour, roughness=0.88):
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    tree.nodes.clear()
    out = tree.nodes.new("ShaderNodeOutputMaterial")
    shader = tree.nodes.new("ShaderNodeBsdfPrincipled")
    shader.inputs["Base Color"].default_value = colour
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = 0.0
    tree.links.new(shader.outputs["BSDF"], out.inputs["Surface"])
    mat.diffuse_color = colour
    return mat


def add_mesh(name, verts, faces, mat, collection):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    mesh.validate(verbose=False)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(mat)
    collection.objects.link(obj)
    return obj


def add_box(name, x0, x1, y0, y1, z0, z1, mat, collection):
    verts = [
        blender_point(x0, y0, z0),
        blender_point(x1, y0, z0),
        blender_point(x1, y0, z1),
        blender_point(x0, y0, z1),
        blender_point(x0, y1, z0),
        blender_point(x1, y1, z0),
        blender_point(x1, y1, z1),
        blender_point(x0, y1, z1),
    ]
    faces = [
        (0, 1, 2, 3),
        (7, 6, 5, 4),
        (0, 4, 5, 1),
        (1, 5, 6, 2),
        (2, 6, 7, 3),
        (3, 7, 4, 0),
    ]
    return add_mesh(name, verts, faces, mat, collection)


def add_slab(name, rings, level, thickness, mat, collection):
    outer = rings[0]
    if outer[0] == outer[-1]:
        outer = outer[:-1]
    top_ring = [Vector((float(x), -float(z), float(level))) for x, z in outer]
    holes = []
    for ring in rings[1:]:
        if ring[0] == ring[-1]:
            ring = ring[:-1]
        holes.append([Vector((float(x), -float(z), float(level))) for x, z in ring])
    loops = [top_ring] + holes
    triangles = tessellate_polygon(loops)
    bottom_loops = [[Vector((v.x, v.y, float(level) - thickness)) for v in loop] for loop in loops]
    bottom_triangles = tessellate_polygon(bottom_loops)
    verts = []
    for loop in loops:
        verts.extend(loop)
    n_top = len(verts)
    for loop in bottom_loops:
        verts.extend(loop)
    faces = []
    for a, b, c in triangles:
        faces.append((int(a), int(b), int(c)))
    for a, b, c in bottom_triangles:
        faces.append((n_top + int(c), n_top + int(b), n_top + int(a)))
    # Side walls for outer ring and each hole.
    offset = 0
    for loop in loops:
        n = len(loop)
        for i in range(n):
            j = (i + 1) % n
            faces.append((offset + i, offset + j, n_top + offset + j, n_top + offset + i))
        offset += n
    return add_mesh(name, verts, faces, mat, collection)


def add_wedge(name, x0, x1, z0, z1, y0, y1, axis, high, mat, collection):
    """Solid stair wedge: flat bottom, vertical high end, sloped top."""
    bottom = [
        blender_point(x0, y0, z0),
        blender_point(x1, y0, z0),
        blender_point(x1, y0, z1),
        blender_point(x0, y0, z1),
    ]
    if axis == "z":
        high_z = z1 if high == "max" else z0
        high_edge = [blender_point(x0, y1, high_z), blender_point(x1, y1, high_z)]
        if high == "max":
            faces = [
                (0, 3, 2, 1),
                (3, 2, 5, 4),
                (0, 1, 5, 4),
                (0, 4, 3),
                (1, 2, 5),
            ]
        else:
            faces = [
                (0, 3, 2, 1),
                (0, 1, 5, 4),
                (4, 5, 2, 3),
                (0, 4, 3),
                (1, 2, 5),
            ]
    else:
        high_x = x1 if high == "max" else x0
        high_edge = [blender_point(high_x, y1, z0), blender_point(high_x, y1, z1)]
        if high == "max":
            faces = [
                (0, 3, 2, 1),
                (1, 2, 5, 4),
                (0, 3, 5, 4),
                (0, 4, 1),
                (3, 2, 5),
            ]
        else:
            faces = [
                (0, 3, 2, 1),
                (0, 3, 5, 4),
                (4, 5, 2, 1),
                (0, 4, 1),
                (3, 2, 5),
            ]
    verts = bottom + high_edge
    return add_mesh(name, verts, faces, mat, collection)


def add_ramp(name, corners, thickness, mat, collection):
    top = [blender_point(x, y, z) for x, y, z in corners]
    bottom = [Vector((v.x, v.y, v.z - thickness)) for v in top]
    verts = top + bottom
    faces = [
        (0, 1, 2, 3),
        (7, 6, 5, 4),
        (0, 4, 5, 1),
        (1, 5, 6, 2),
        (2, 6, 7, 3),
        (3, 7, 4, 0),
    ]
    return add_mesh(name, verts, faces, mat, collection)


def recalc_normals(objects):
    for obj in objects:
        if obj.type != "MESH":
            continue
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(obj.data)
        bm.free()
        obj.data.update()


def collection(name, parent=None):
    c = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(c)
    return c


def import_reference(spec, reference_parent):
    if not REFERENCE.exists():
        return 0
    ghost = material("Reference_Ghost", (0.16, 0.17, 0.18, 1.0), roughness=0.95)
    ghost.diffuse_color = (0.30, 0.31, 0.33, 0.22)
    entries = spec.get("reference") or [
        {"floor": int(path.stem.split("_f")[1]), "file": path.name}
        for path in sorted(REFERENCE.glob("rpd_f*.ply"))
    ]
    count = 0
    for entry in entries:
        floor = entry["floor"]
        c = collection(f"Ref_F{floor}", reference_parent)
        path = REFERENCE / entry["file"]
        before = set(bpy.context.scene.objects)
        bpy.ops.wm.ply_import(filepath=str(path))
        new = [o for o in bpy.context.scene.objects if o not in before]
        for obj in new:
            for col in list(obj.users_collection):
                col.objects.unlink(obj)
            c.objects.link(obj)
            obj.data.materials.clear()
            obj.data.materials.append(ghost)
            obj.display_type = "WIRE"
            obj.hide_render = True
            obj.show_in_front = True
            obj.name = f"Reference_F{floor}"
            count += 1
    return count


def build_floor(spec_floor, parent):
    floor = spec_floor["floor"]
    root = collection(f"F{floor}", parent)
    meshes = {}
    for kind in ("floor", "wall", "pillar", "stair", "ramp"):
        meshes[kind] = []

    for slab in spec_floor["slabs"]:
        meshes["floor"].append((slab,))
    for wall in spec_floor["walls"]:
        meshes["wall"].append((wall,))
    for pillar in spec_floor["pillars"]:
        meshes["pillar"].append((pillar,))
    for stair in spec_floor["stairs"]:
        meshes["stair"].append((stair,))
    for ramp in spec_floor["ramps"]:
        meshes["ramp"].append((ramp,))

    objects = []
    floor_mat = material("Blockout_Floor", FLOOR_COLOURS["floor"])
    wall_mat = material("Blockout_Wall", FLOOR_COLOURS["wall"])
    pillar_mat = material("Blockout_Pillar", FLOOR_COLOURS["pillar"])
    stair_mat = material("Blockout_Stair", FLOOR_COLOURS["stair"])
    ramp_mat = material("Blockout_Ramp", FLOOR_COLOURS["ramp"])

    for i, (slab,) in enumerate(meshes["floor"]):
        objects.append(
            add_slab(
                f"F{floor}_Slab_{i:03d}",
                slab["rings"],
                slab["level"],
                0.25,
                floor_mat,
                root,
            )
        )
    for i, (wall,) in enumerate(meshes["wall"]):
        axis = wall["axis"]
        plane = wall["plane"]
        u0, u1 = wall["u0"], wall["u1"]
        y0, y1 = wall["y0"], wall["y1"]
        t = wall["thickness"] * 0.5
        kind = wall["kind"]
        if axis == "x":
            x0, x1 = plane - t, plane + t
            z0, z1 = u0, u1
        else:
            z0, z1 = plane - t, plane + t
            x0, x1 = u0, u1
        if kind == "door":
            top = wall["open_top"]
            if y1 - top > 0.05:
                objects.append(
                    add_box(
                        f"F{floor}_Lintel_{i:03d}",
                        x0, x1, top, y1, z0, z1, wall_mat, root,
                    )
                )
        elif kind == "window":
            sill = wall["open_bottom"]
            top = wall["open_top"]
            if sill - y0 > 0.05:
                objects.append(
                    add_box(
                        f"F{floor}_Sill_{i:03d}",
                        x0, x1, y0, sill, z0, z1, wall_mat, root,
                    )
                )
            if y1 - top > 0.05:
                objects.append(
                    add_box(
                        f"F{floor}_Lintel_{i:03d}",
                        x0, x1, top, y1, z0, z1, wall_mat, root,
                    )
                )
        elif kind == "half":
            if y1 - y0 > 0.2:
                objects.append(
                    add_box(
                        f"F{floor}_Wall_{i:03d}",
                        x0, x1, y0, min(y1, y0 + HALF_WALL_HEIGHT),
                        z0, z1, wall_mat, root,
                    )
                )
        else:
            objects.append(
                add_box(f"F{floor}_Wall_{i:03d}", x0, x1, y0, y1, z0, z1, wall_mat, root)
            )
    for i, (pillar,) in enumerate(meshes["pillar"]):
        objects.append(
            add_box(
                f"F{floor}_Pillar_{i:03d}",
                pillar["x0"], pillar["x1"], pillar["y0"], pillar["y1"],
                pillar["z0"], pillar["z1"], pillar_mat, root,
            )
        )
    for i, (stair,) in enumerate(meshes["stair"]):
        objects.append(
            add_wedge(
                f"F{floor}_Stair_{i:03d}",
                stair["x0"], stair["x1"], stair["z0"], stair["z1"],
                stair["y0"], stair["y1"], stair["axis"], stair["high"],
                stair_mat, root,
            )
        )
    for i, (ramp,) in enumerate(meshes["ramp"]):
        objects.append(
            add_ramp(
                f"F{floor}_Ramp_{i:03d}",
                ramp["corners"],
                0.22,
                ramp_mat,
                root,
            )
        )
    print(
        f"floor {floor}: {len(meshes['floor'])} slabs, {len(meshes['wall'])} walls, "
        f"{len(meshes['pillar'])} pillars, {len(meshes['stair'])} stairs, "
        f"{len(meshes['ramp'])} ramps"
    )
    return objects


def setup_scene():
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 800
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.055, 0.060, 0.070, 1.0)
        bg.inputs[1].default_value = 0.8

    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = 2.6
    sun.angle = math.radians(8)
    sun_obj = bpy.data.objects.new("Sun", sun)
    bpy.context.scene.collection.objects.link(sun_obj)
    sun_obj.rotation_euler = (math.radians(52), 0, math.radians(38))

    fill = bpy.data.lights.new("Fill", "AREA")
    fill.energy = 900
    fill.shape = "SQUARE"
    fill.size = 40
    fill_obj = bpy.data.objects.new("Fill", fill)
    bpy.context.scene.collection.objects.link(fill_obj)
    fill_obj.location = (0, 30, 45)
    fill_obj.rotation_euler = (math.radians(25), 0, 0)

    ceiling = bpy.data.lights.new("InteriorFill", "AREA")
    ceiling.energy = 4500
    ceiling.shape = "SQUARE"
    ceiling.size = 45
    ceiling_obj = bpy.data.objects.new("InteriorFill", ceiling)
    bpy.context.scene.collection.objects.link(ceiling_obj)
    ceiling_obj.location = (0, 5, 26)


def setup_cameras():
    scene = bpy.context.scene
    cameras = []
    for name, loc, target, lens in (
        ("Overview", (62, -62, 58), (0, 0, 5), 55),
        ("MainHall", (0, -8.5, 2.0), (0, 16.4, 4.4), 18),
        ("FloorView", (58, -58, 48), (0, 0, 0), 55),
        ("Top", (0, 0, 90), (0, 0, 0), 55),
    ):
        cam = bpy.data.cameras.new(name)
        cam.lens = lens
        obj = bpy.data.objects.new(name, cam)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = loc
        direction = Vector(target) - Vector(loc)
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        cameras.append(obj)
    scene.camera = cameras[0]
    return cameras


def set_floor_visibility(root, visible):
    for child in root.children:
        try:
            floor = int(child.name[1:])
        except ValueError:
            continue
        child.hide_render = floor not in visible


def render_views(cameras, root, samples=48, only="", workbench=False):
    RENDERS.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    if workbench:
        shading = scene.display.shading
        shading.light = "STUDIO"
        shading.studio_light = "paint.sl"
        shading.color_type = "MATERIAL"
        shading.show_shadows = True
        shading.show_cavity = True
        shading.cavity_type = "BOTH"
        shading.show_object_outline = False
    scene.cycles.samples = samples
    by_name = {cam.name: cam for cam in cameras}
    views = [
        ("overview", "Overview", {1, 2, 3}, "ortho", 105, 0.0),
        ("main_hall", "MainHall", {1, 2}, "persp", 0, 0.0),
        ("floor_1", "FloorView", {1}, "ortho", 95, 0.0),
        ("floor_2", "FloorView", {2}, "ortho", 95, 5.0),
        ("floor_3", "FloorView", {3}, "ortho", 95, 10.25),
        ("top", "Top", {1, 2, 3}, "ortho", 100, 0.0),
    ]
    for name, cam_name, visible, kind, scale, level in views:
        if only and name != only:
            continue
        cam = by_name[cam_name]
        set_floor_visibility(root, visible)
        if workbench and name != "main_hall":
            scene.render.engine = "BLENDER_WORKBENCH"
        else:
            scene.render.engine = "CYCLES"
        scene.camera = cam
        if cam_name == "FloorView":
            cam.location = (58, -58, 48 + level)
            direction = Vector((0, 0, level)) - Vector(cam.location)
            cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        if kind == "ortho":
            cam.data.type = "ORTHO"
            cam.data.ortho_scale = scale
        else:
            cam.data.type = "PERSP"
        scene.render.filepath = str(RENDERS / f"{name}.png")
        scene.render.resolution_x = 1400
        scene.render.resolution_y = 900
        bpy.ops.render.render(write_still=True)
        print(f"rendered {scene.render.filepath}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-render", action="store_true")
    parser.add_argument("--no-reference", action="store_true")
    parser.add_argument("--samples", type=int, default=48)
    parser.add_argument("--only", default="")
    parser.add_argument("--workbench", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else [])
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    clear_scene()
    scene = bpy.context.scene

    blockout_root = collection("RPD_Blockout")
    reference_root = collection("RPD_Reference")
    setup_scene()
    if not args.no_reference:
        count = import_reference(spec, reference_root)
        print(f"imported {count} reference objects")

    objects = []
    for floor in spec["floors"]:
        objects.extend(build_floor(floor, blockout_root))
    recalc_normals(objects)

    cameras = setup_cameras()
    scene.camera = cameras[0]

    note = bpy.data.texts.new("RPD_BLOCKOUT")
    note.write(
        "RPD blockout.\n"
        "\n"
        "RPD_Blockout holds the simplified model: floor slabs, walls with door\n"
        "gaps, pillars, stair wedges and ramp slabs, in three floor collections.\n"
        "RPD_Reference holds the decompiled source meshes as a wireframe, hidden\n"
        "from render. Toggle that collection to check alignment.\n"
        "\n"
        "Units are metres. Source coordinates are (x, y, z) with Y up; this\n"
        "scene is Z up with blender = (x, -z, y). Scale is unchanged.\n"
        "\n"
        "Generated by tools/blockout_extract.py and tools/blockout_scene.py.\n"
    )

    bpy.ops.object.select_all(action="DESELECT")
    for obj in blockout_root.all_objects:
        obj.select_set(True)
    BUILD.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.obj_export(
        filepath=str(BUILD / "blockout.obj"),
        export_selected_objects=True,
        export_materials=True,
    )
    bpy.ops.export_scene.gltf(
        filepath=str(BUILD / "blockout.glb"),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
    )
    print(f"wrote {BUILD / 'blockout.obj'} and blockout.glb")
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND))
    print(f"saved {BLEND}")

    if not args.no_render:
        render_views(
            cameras, blockout_root, samples=args.samples, only=args.only,
            workbench=args.workbench,
        )


if __name__ == "__main__":
    main()
