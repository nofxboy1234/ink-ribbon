#!/usr/bin/env python3
"""Export the decompiled main-hall mesh as a Blender reference OBJ."""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import remesh
from build_real import submesh_triangles

ROOT = pathlib.Path(__file__).resolve().parents[1]
src = ROOT / "data/raw/rpd/st4_101_0.mesh"
out = ROOT / "build/entrance_original.obj"
m = remesh.parse(src.read_bytes())
n = 0
with out.open("w") as f:
    f.write("o st4_101_0\n")
    for g in m.lods[0].groups:
        pos = remesh.positions(m, g)
        for s in g.submeshes:
            f.write(f"usemtl mat{s.material}\n")
            for a, b, c in submesh_triangles(m, g, s):
                for i in (a, b, c):
                    x, y, z = pos[i]
                    f.write(f"v {x:.4f} {y:.4f} {z:.4f}\n")
                f.write(f"f {n+1} {n+2} {n+3}\n")
                n += 3
print(f"wrote {out}: {n//3} triangles")
