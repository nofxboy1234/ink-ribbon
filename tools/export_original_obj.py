#!/usr/bin/env python3
"""Export the decompiled RPD architectural meshes as OBJ for Blender."""
from __future__ import annotations

import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import build_blockout as bb
import remesh

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "rpd"
OUT = ROOT / "build" / "rpd_original.obj"
KEEP = ("wall", "floor", "window", "door", "stair", "pillar", "ceiling")


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    verts = 0
    faces = 0
    with OUT.open("w", encoding="utf-8") as out:
        for path in sorted(RAW.glob("*.mesh")):
            data = path.read_bytes()
            mesh = remesh.parse(data)
            names = bb.material_names(data)
            out.write(f"o {path.stem}\n")
            for group in mesh.lods[0].groups:
                gpos = remesh.positions(mesh, group)
                for sub in group.submeshes:
                    name = names[sub.material] if sub.material < len(names) else "unknown"
                    if not any(k in name.lower() for k in KEEP):
                        continue
                    out.write(f"usemtl {name}\n")
                    for a, b, c in bb.submesh_triangles(mesh, group, sub):
                        for idx in (a, b, c):
                            x, y, z = gpos[idx]
                            out.write(f"v {x:.4f} {y:.4f} {z:.4f}\n")
                        out.write(f"f {verts + 1} {verts + 2} {verts + 3}\n")
                        verts += 3
                        faces += 1
    print(f"wrote {OUT.relative_to(ROOT)}: {verts:,} vertices, {faces:,} faces")


if __name__ == "__main__":
    main()
