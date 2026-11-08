#!/usr/bin/env python3
"""Render every packed item model and verify the ITM1 binary against its manifest.

Run:
    blender -b -P tools/render_item_models.py

Each model is written to ``verification/item_models/<id>.png``. The run fails
with a non-zero exit when a header, offset, index or bounds check does not hold,
so a green render pass is evidence that the loader can consume the asset.
"""

from __future__ import annotations

import hashlib
import json
import math
import pathlib
import struct
import sys

import bpy
import numpy as np
from mathutils import Vector

ROOT = pathlib.Path(__file__).resolve().parents[1]
BIN = ROOT / "public" / "rpd" / "item_models.bin"
MANIFEST = ROOT / "public" / "rpd" / "item_models.json"
TEXTURES = ROOT / "public" / "rpd" / "item_models"
OUT = ROOT / "verification" / "item_models"
REPORT = OUT / "report.json"

HEADER = struct.Struct("<4sIIIIIII")
DIRECTORY = struct.Struct("<24sIIIIIIHH3ff3f3ff3f")
PRIMITIVE = struct.Struct("<IIII")
MATERIAL = struct.Struct("<IIII4f")
VERTEX_STRIDE = 20


def read_strings(data: bytes, offset: int, size: int) -> dict[int, str]:
    table = data[offset : offset + size]
    values: dict[int, str] = {}
    start = 0
    for index, byte in enumerate(table):
        if byte == 0:
            values[start] = table[start:index].decode("utf-8", "replace")
            start = index + 1
    return values


def texture_path(strings: dict[int, str], offset: int) -> str | None:
    if not offset:
        return None
    return strings.get(offset) or None


def verify(manifest: dict, data: bytes):
    failures: list[str] = []
    if len(data) < HEADER.size:
        raise SystemExit("item_models.bin shorter than the header")
    magic, version, model_count, material_count, directory, material_table, string_table, string_size = (
        HEADER.unpack_from(data, 0)
    )
    if magic != b"ITM1":
        failures.append(f"bad magic {magic!r}")
    if version != manifest["version"]:
        failures.append(f"binary version {version} != manifest {manifest['version']}")
    if model_count != len(manifest["models"]):
        failures.append(f"binary model count {model_count} != manifest {len(manifest['models'])}")
    if material_count != len(manifest["materials"]):
        failures.append(
            f"binary material count {material_count} != manifest {len(manifest['materials'])}"
        )
    strings = read_strings(data, string_table, string_size)
    materials = []
    for index in range(material_count):
        offset = material_table + index * MATERIAL.size
        albedo, albedo_source, normal_source, flags, *color = MATERIAL.unpack_from(data, offset)
        materials.append(
            {
                "albedo": texture_path(strings, albedo),
                "albedo_source": texture_path(strings, albedo_source),
                "normal_source": texture_path(strings, normal_source),
                "base_color": color,
            }
        )

    entries = []
    for index in range(model_count):
        offset = directory + index * DIRECTORY.size
        (
            name,
            vertex_offset,
            vertex_count,
            index_offset,
            index_count,
            primitive_offset,
            primitive_count,
            index_size,
            lod,
            *rest,
        ) = DIRECTORY.unpack_from(data, offset)
        origin = rest[0:3]
        quant_scale = rest[3]
        bounds_min = rest[4:7]
        bounds_max = rest[7:10]
        metres_per_unit = rest[10]
        pivot = rest[11:14]
        model_id = name.split(b"\0", 1)[0].decode()
        if model_id not in manifest["models"]:
            failures.append(f"binary model {model_id} missing from manifest")
            continue
        if index_size not in (2, 4):
            failures.append(f"{model_id}: index size {index_size}")
        if vertex_offset + vertex_count * VERTEX_STRIDE > len(data):
            failures.append(f"{model_id}: vertex buffer past the file end")
        if index_offset + index_count * index_size > len(data):
            failures.append(f"{model_id}: index buffer past the file end")
        if quant_scale <= 0:
            failures.append(f"{model_id}: non-positive quant scale {quant_scale}")
        if abs(bounds_min[1]) > 1e-4:
            failures.append(f"{model_id}: pivot y is not on the base ({bounds_min[1]:.6f})")
        if abs(bounds_min[0] + bounds_max[0]) > 2e-3:
            failures.append(f"{model_id}: x bounds are not centred ({bounds_min[0]}, {bounds_max[0]})")
        if abs(bounds_min[2] + bounds_max[2]) > 2e-3:
            failures.append(f"{model_id}: z bounds are not centred ({bounds_min[2]}, {bounds_max[2]})")
        extent = max(bounds_max[i] - bounds_min[i] for i in range(3))
        if abs(extent - 1.0) > 2e-3:
            failures.append(f"{model_id}: normalised extent {extent:.6f} is not 1.0")
        primitives = []
        for primitive_index in range(primitive_count):
            primitive_data = PRIMITIVE.unpack_from(
                data, primitive_offset + primitive_index * PRIMITIVE.size
            )
            primitive = {
                "index_start": primitive_data[0],
                "index_count": primitive_data[1],
                "material": primitive_data[2],
                "flags": primitive_data[3],
            }
            if primitive["index_start"] + primitive["index_count"] > index_count:
                failures.append(f"{model_id}: primitive runs past the index count")
            if primitive["material"] >= material_count:
                failures.append(f"{model_id}: primitive material {primitive['material']} out of range")
            primitives.append(primitive)
        vertices = np.frombuffer(
            data,
            dtype=np.dtype([("x", "<u2"), ("y", "<u2"), ("z", "<u2"), ("nx", "<i2"), ("ny", "<i2"), ("nz", "<i2"), ("nw", "<i2"), ("u", "<u2"), ("v", "<u2"), ("pad", "<u2")]),
            count=vertex_count,
            offset=vertex_offset,
        )
        index_dtype = np.uint32 if index_size == 4 else np.uint16
        indices = np.frombuffer(
            data, dtype=index_dtype, count=index_count, offset=index_offset
        )
        if index_count and int(indices.max()) >= vertex_count:
            failures.append(f"{model_id}: index {int(indices.max())} outside {vertex_count} vertices")
        positions = np.stack(
            [
                vertices["x"] * quant_scale + origin[0],
                vertices["y"] * quant_scale + origin[1],
                vertices["z"] * quant_scale + origin[2],
            ],
            axis=1,
        )
        if len(positions):
            actual_min = positions.min(axis=0)
            actual_max = positions.max(axis=0)
            for axis in range(3):
                if abs(actual_min[axis] - bounds_min[axis]) > 2e-3:
                    failures.append(f"{model_id}: decoded minimum differs on axis {axis}")
                if abs(actual_max[axis] - bounds_max[axis]) > 2e-3:
                    failures.append(f"{model_id}: decoded maximum differs on axis {axis}")
        entries.append(
            {
                "id": model_id,
                "vertex_offset": vertex_offset,
                "vertex_count": vertex_count,
                "index_offset": index_offset,
                "index_count": index_count,
                "index_size": index_size,
                "lod": lod,
                "origin": list(origin),
                "quant_scale": quant_scale,
                "bounds_min": list(bounds_min),
                "bounds_max": list(bounds_max),
                "metres_per_unit": metres_per_unit,
                "pivot": list(pivot),
                "primitives": primitives,
                "positions": positions,
                "vertices": vertices,
                "indices": indices,
            }
        )
    return failures, materials, entries


def clear_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 256
    scene.render.resolution_y = 256
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"
    if hasattr(scene, "eevee"):
        scene.eevee.taa_render_samples = 24
    world = bpy.data.worlds.new("Item World")
    background = world.node_tree.nodes.get("Background")
    if background is not None:
        background.inputs["Color"].default_value = (0.55, 0.57, 0.62, 1.0)
        background.inputs["Strength"].default_value = 0.7
    scene.world = world
    sun = bpy.data.lights.new("Key", type="SUN")
    sun.energy = 3.5
    sun_object = bpy.data.objects.new("Key", sun)
    scene.collection.objects.link(sun_object)
    sun_object.rotation_euler = (math.radians(50), 0.0, math.radians(35))
    fill = bpy.data.lights.new("Fill", type="AREA")
    fill.energy = 60.0
    fill.size = 2.0
    fill_object = bpy.data.objects.new("Fill", fill)
    scene.collection.objects.link(fill_object)
    fill_object.location = (2.0, 2.0, 2.5)
    fill_object.rotation_euler = (math.radians(45), 0.0, math.radians(140))


def make_material(material: dict):
    material_node = bpy.data.materials.new("item")
    material_node.use_nodes = True
    nodes = material_node.node_tree.nodes
    links = material_node.node_tree.links
    principled = nodes.get("Principled BSDF")
    color = material["base_color"]
    principled.inputs["Base Color"].default_value = (*color[:3], color[3])
    principled.inputs["Roughness"].default_value = 0.55
    principled.inputs["Metallic"].default_value = 0.0
    if material["albedo"]:
        image_path = ROOT / "public" / "rpd" / material["albedo"]
        image = bpy.data.images.load(str(image_path), check_existing=True)
        texture = nodes.new("ShaderNodeTexImage")
        texture.image = image
        texture.interpolation = "Linear"
        if tuple(round(value, 3) for value in color) == (1.0, 1.0, 1.0, 1.0):
            links.new(texture.outputs["Color"], principled.inputs["Base Color"])
        else:
            mix = nodes.new("ShaderNodeMixRGB")
            mix.blend_type = "MULTIPLY"
            mix.inputs[0].default_value = 1.0
            links.new(texture.outputs["Color"], mix.inputs[1])
            mix.inputs[2].default_value = (*color[:3], 1.0)
            links.new(mix.outputs["Color"], principled.inputs["Base Color"])
    return material_node


def build_model(entry: dict, materials: list[dict]):
    positions = entry["positions"]
    vertices = entry["vertices"]
    indices = entry["indices"]
    # Source is Y up. Blender is Z up.
    blender_positions = np.stack(
        [positions[:, 0], -positions[:, 2], positions[:, 1]], axis=1
    ).astype(np.float64)
    normals = np.stack(
        [
            vertices["nx"].astype(np.float64) / 32767.0,
            -vertices["nz"].astype(np.float64) / 32767.0,
            vertices["ny"].astype(np.float64) / 32767.0,
        ],
        axis=1,
    )
    uv = np.stack(
        [
            vertices["u"].view(np.float16).astype(np.float64),
            vertices["v"].view(np.float16).astype(np.float64),
        ],
        axis=1,
    )
    faces = indices.reshape(-1, 3).tolist()
    mesh = bpy.data.meshes.new(entry["id"])
    mesh.from_pydata(blender_positions.tolist(), [], faces)
    mesh.normals_split_custom_set_from_vertices(normals.tolist())
    layer = mesh.uv_layers.new(name="UVMap")
    for loop in mesh.loops:
        u, v = uv[loop.vertex_index]
        layer.data[loop.index].uv = (float(u), 1.0 - float(v))
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    object_ = bpy.data.objects.new(entry["id"], mesh)
    bpy.context.collection.objects.link(object_)

    slots = {}
    for primitive_index, primitive in enumerate(entry["primitives"]):
        material_index = primitive["material"]
        if material_index not in slots:
            slots[material_index] = len(object_.data.materials)
            object_.data.materials.append(make_material(materials[material_index]))
        start = primitive["index_start"] // 3
        count = primitive["index_count"] // 3
        for polygon_index in range(start, start + count):
            object_.data.polygons[polygon_index].material_index = slots[material_index]
    return object_


def frame(object_, direction=(1.0, -1.5, 0.9)):
    corners = [object_.matrix_world @ Vector(corner) for corner in object_.bound_box]
    low = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    high = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    centre = (low + high) * 0.5
    size = max(high - low)
    camera_data = bpy.data.cameras.new("Camera")
    camera_data.lens = 55.0
    camera = bpy.data.objects.new("Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    offset = Vector(direction).normalized() * (2.6 * size)
    camera.location = centre + offset
    camera.rotation_euler = (centre - camera.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = camera
    return camera


def main() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    data = BIN.read_bytes()
    failures, materials, entries = verify(manifest, data)
    OUT.mkdir(parents=True, exist_ok=True)
    for stale in OUT.glob("*.png"):
        stale.unlink()

    for material in materials:
        if material["albedo"]:
            path = ROOT / "public" / "rpd" / material["albedo"]
            if not path.is_file():
                failures.append(f"missing albedo {material['albedo']}")

    clear_scene()
    report = []
    for entry in entries:
        object_ = build_model(entry, materials)
        camera = frame(object_)
        target = OUT / f"{entry['id']}.png"
        bpy.context.scene.render.filepath = str(target)
        bpy.ops.render.render(write_still=True)
        camera_data = camera.data
        bpy.data.objects.remove(camera, do_unlink=True)
        bpy.data.cameras.remove(camera_data)
        mesh = object_.data
        bpy.data.objects.remove(object_, do_unlink=True)
        bpy.data.meshes.remove(mesh)
        for material_node in list(bpy.data.materials):
            bpy.data.materials.remove(material_node)
        report.append(
            {
                "id": entry["id"],
                "title": manifest["models"][entry["id"]]["title"],
                "category": manifest["models"][entry["id"]]["category"],
                "status": manifest["models"][entry["id"]]["status"],
                "vertices": entry["vertex_count"],
                "triangles": entry["index_count"] // 3,
                "primitives": len(entry["primitives"]),
                "bounds_source": manifest["models"][entry["id"]]["bounds"]["source"],
                "metres_per_unit": entry["metres_per_unit"],
                "image": str(target.relative_to(ROOT)),
                "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            }
        )

    REPORT.write_text(
        json.dumps(
            {
                "asset": str(BIN.relative_to(ROOT)),
                "models": len(entries),
                "failures": failures,
                "report": report,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"rendered {len(report)} item models to {OUT.relative_to(ROOT)}")
    if failures:
        print(f"FAILED {len(failures)} checks")
        for failure in failures:
            print("  " + failure)
        sys.exit(1)
    print("all binary and bounds checks passed")


if __name__ == "__main__":
    main()
