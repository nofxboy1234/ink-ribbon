#!/usr/bin/env python3
"""Assemble the simplified blockout in Blender from the decompiled RPD spec."""
from __future__ import annotations

import json
import pathlib
import sys

import bpy

ROOT = pathlib.Path(__file__).resolve().parents[1]
ORIGINAL = ROOT / "build" / "rpd_original.obj"
SPEC = ROOT / "build" / "blockout_spec.json"
OUT = ROOT / "build" / "blockout_blender.obj"


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def make_mesh(name: str, verts, faces, edges=(), material=None):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, list(edges), list(faces))
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    if material is not None:
        obj.data.materials.append(material)
    return obj


def export_custom(objects) -> None:
    """Write faces and real mesh/stair edges as a small OBJ."""
    all_verts = []
    face_groups = {"structure": [], "floor": []}
    edge_groups = {"structure": [], "floor": []}
    for obj, kind, edge_kind in objects:
        base = len(all_verts)
        verts = [tuple(v.co) for v in obj.data.vertices]
        all_verts.extend(verts)
        for poly in obj.data.polygons:
            idx = tuple(base + i for i in poly.vertices)
            face_groups["floor" if kind == "floor" else "structure"].append(idx)
        for e in obj.data.edges:
            a, b = base + e.vertices[0], base + e.vertices[1]
            edge_groups["floor" if edge_kind == "floor" else "structure"].append((a, b))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as out:
        out.write("# simplified RPD blockout, exported from Blender\n")
        for x, y, z in all_verts:
            out.write(f"v {x:.5f} {y:.5f} {z:.5f}\n")
        for group in ("structure", "floor"):
            out.write(f"g {group}_faces\n")
            for face in face_groups[group]:
                out.write("f " + " ".join(str(i + 1) for i in face) + "\n")
        for group in ("structure", "floor"):
            out.write(f"g {group}_edges\n")
            for a, b in edge_groups[group]:
                out.write(f"l {a + 1} {b + 1}\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(all_verts):,} verts, "
          f"{sum(map(len, face_groups.values())):,} faces")


def main() -> None:
    clear_scene()
    if ORIGINAL.exists():
        bpy.ops.wm.obj_import(filepath=str(ORIGINAL))
        imported = len(bpy.context.scene.objects)
        clear_scene()
        print(f"imported original RPD reference: {imported} objects; removed")
    spec = json.loads(SPEC.read_text(encoding="utf-8"))

    wall_verts, wall_faces, wall_edges = [], [], []
    floor_verts, floor_faces, floor_edges = [], [], []
    stair_verts, stair_faces, stair_edges = [], [], []
    line_verts, line_edges = [], []

    def add_box(x0, x1, y0, y1, z0, z1):
        base = len(wall_verts)
        pts = [(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),
               (x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)]
        wall_verts.extend(pts)
        wall_faces.extend([(base,base+1,base+2,base+3),(base+4,base+7,base+6,base+5),
                           (base,base+4,base+5,base+1),(base+3,base+2,base+6,base+7),
                           (base,base+3,base+7,base+4),(base+1,base+5,base+6,base+2)])
        for a,b in ((0,1),(1,2),(2,3),(3,0),(4,5),(5,6),(6,7),(7,4),(0,4),(1,5),(2,6),(3,7)):
            wall_edges.append((base+a, base+b))

    for x0, x1, y0, y1, z0, z1 in spec["walls"]:
        add_box(x0, x1, y0, y1, z0, z1)

    for quad in spec["floors"]:
        base = len(floor_verts); floor_verts.extend(tuple(p) for p in quad)
        floor_faces.append((base,base+1,base+2,base+3))
        floor_edges.extend([(base,base+1),(base+1,base+2),(base+2,base+3),(base+3,base)])
    for quad in spec["stairs"]:
        base = len(stair_verts); stair_verts.extend(tuple(p) for p in quad)
        stair_faces.append((base,base+1,base+2,base+3))
        stair_edges.extend([(base,base+1),(base+1,base+2),(base+2,base+3),(base+3,base)])
    for p, q, _kind in spec["lines"]:
        base = len(line_verts); line_verts.extend([tuple(p), tuple(q)])
        line_edges.append((base, base+1))

    structure = bpy.data.materials.new("blockout_structure")
    floor = bpy.data.materials.new("blockout_floor")
    objects = []
    objects.append((make_mesh("Blockout_Walls", wall_verts, wall_faces, wall_edges, structure), "structure", "structure"))
    objects.append((make_mesh("Blockout_Floors", floor_verts, floor_faces, floor_edges, floor), "floor", "floor"))
    objects.append((make_mesh("Blockout_Stairs", stair_verts, stair_faces, stair_edges, structure), "structure", "structure"))
    objects.append((make_mesh("Blockout_Lines", line_verts, [], line_edges, structure), "structure", "structure"))
    export_custom(objects)


if __name__ == "__main__":
    main()
