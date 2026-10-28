#!/usr/bin/env python3
"""Replace the original main hall with a simple blockout and export it."""
import pathlib
import bpy

ROOT = pathlib.Path(__file__).resolve().parents[1]
ORIGINAL = ROOT / "build/entrance_original.obj"
OUT = ROOT / "build/simple.obj"


def clear():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def mat(name, shade):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.diffuse_color = (shade, shade, shade, 1.0)
    return m


def mesh(name, verts, faces, material):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(material)
    return ob


def box(name, x0, x1, y0, y1, z0, z1, material):
    v = [(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),
         (x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)]
    f = [(0,1,2,3),(4,7,6,5),(0,4,5,1),(3,2,6,7),(0,3,7,4),(1,5,6,2)]
    return mesh(name, v, f, material)


def wedge(name, x0, x1, z0, z1, y0, y_high, material):
    # Bottom rectangle at floor height, sloped top rising toward z1.
    v = [(x0,y0,z0),(x1,y0,z0),(x1,y_high,z1),(x0,y_high,z1),
         (x0,y0,z1),(x1,y0,z1)]
    f = [(0,1,2,3),(0,4,5,1),(0,3,4),(1,5,2),(3,2,5,4)]
    return mesh(name, v, f, material)


def main():
    clear()
    if ORIGINAL.exists():
        bpy.ops.wm.obj_import(filepath=str(ORIGINAL))
        clear()

    floor = mat("simple_floor", 0.56)
    wall = mat("simple_wall", 0.38)
    column = mat("simple_column", 0.64)
    stair = mat("simple_stair", 0.50)
    trim = mat("simple_trim", 0.72)
    plinth = mat("simple_plinth", 0.31)

    X0, X1 = -10.7, 10.6
    Z0, Z1 = -22.3, 12.2
    FLOOR, UPPER, TOP = 0.0, 5.2, 10.4

    box("Ground", X0, X1, FLOOR-0.2, FLOOR, Z0, Z1, floor)
    box("EntranceLanding", -7.0, 7.0, 0.8, 1.0, 5.4, Z1, floor)

    # Upper balcony ring.
    box("BalconyBack", X0, X1, UPPER, UPPER+0.2, Z0, -16.5, floor)
    box("BalconyLeft", X0, -7.0, UPPER, UPPER+0.2, -16.5, Z1, floor)
    box("BalconyRight", 7.0, X1, UPPER, UPPER+0.2, -16.5, Z1, floor)

    # Main stair flights.
    wedge("StairLeft", -7.0, -3.5, -8.9, -16.0, 0.8, UPPER, stair)
    wedge("StairRight", 3.5, 7.0, -8.9, -16.0, 0.8, UPPER, stair)

    # Back, side and front walls.
    box("BackWall", X0, X1, FLOOR, TOP, Z0, Z0+0.3, wall)
    box("LeftWall", X0, X0+0.3, FLOOR, TOP, Z0, Z1, wall)
    box("RightWall", X1-0.3, X1, FLOOR, TOP, Z0, Z1, wall)

    # Columns and balcony rails.
    for x in (-8.8, 8.8):
        for z in (-20.0, -12.0, -4.0, 4.0, 10.0):
            box(f"Column{x}_{z}", x-0.35, x+0.35, FLOOR, TOP, z-0.35, z+0.35, column)
    for x in (-7.0, 7.0):
        box(f"Rail{x}", x-0.12, x+0.12, UPPER+0.2, UPPER+1.1, -16.5, Z1, trim)
    box("RailBack", -7.0, 7.0, UPPER+0.2, UPPER+1.1, -16.5, -16.3, trim)

    # Statue plinth and simplified figure.
    box("Plinth", -2.2, 2.2, UPPER+0.2, UPPER+1.0, -15.7, -12.9, plinth)
    box("Figure", -1.1, 1.1, UPPER+1.0, UPPER+3.0, -14.8, -13.8, trim)

    bpy.ops.wm.obj_export(filepath=str(OUT), export_materials=True,
                          export_selected_objects=False, forward_axis='Y',
                          up_axis='Z')
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
