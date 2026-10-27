#!/usr/bin/env python3
"""Convert the Blender-exported blockout OBJ into the renderer's RPDW v4 asset."""
from __future__ import annotations

import json
import pathlib
import struct

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
OBJ = ROOT / "build" / "blockout_blender.obj"
OUT = ROOT / "public" / "rpd" / "blockout.bin"
META = ROOT / "public" / "rpd" / "blockout.json"


def main() -> None:
    verts = []
    faces = {"structure": [], "floor": []}
    edge_groups = {"structure": set(), "floor": set()}
    group = "structure"
    for line in OBJ.read_text(encoding="utf-8").splitlines():
        if line.startswith("g "):
            group = line[2:].strip()
        elif line.startswith("v "):
            _, x, y, z = line.split()
            verts.append((float(x), float(y), float(z)))
        elif line.startswith("f "):
            idx = [int(x.split("/")[0]) - 1 for x in line.split()[1:]]
            key = "floor" if group.startswith("floor") else "structure"
            for i in range(1, len(idx) - 1):
                faces[key].append((idx[0], idx[i], idx[i + 1]))
        elif line.startswith("l "):
            a, b = (int(x.split("/")[0]) - 1 for x in line.split()[1:3])
            key = "floor" if group.startswith("floor") else "structure"
            edge_groups[key].add((a, b) if a < b else (b, a))

    p = np.asarray(verts, dtype="<f4")
    tris = np.asarray(faces["structure"] + faces["floor"], dtype="<u4")
    se = np.asarray(sorted(edge_groups["structure"]), dtype="<u4")
    ge = np.asarray(sorted(edge_groups["floor"]), dtype="<u4")
    vmin, vmax = p.min(axis=0), p.max(axis=0)

    with OUT.open("wb") as f:
        f.write(b"RPDW")
        f.write(struct.pack("<IIIIIII", 4, len(p), len(tris), len(se), len(ge), 3, 0))
        f.write(struct.pack("<3f", *vmin))
        f.write(struct.pack("<3f", *vmax))
        for level in (0.0, 5.0, 10.25):
            f.write(struct.pack("<ffff", level, level + 3.2, 0.0, 0.0))
        f.write(p.tobytes())
        f.write(tris.tobytes())
        f.write(se.tobytes())
        f.write(ge.tobytes())

    meta = {
        "asset": OUT.name,
        "version": 4,
        "method": "Blender-assembled simplified blockout",
        "vertices": int(len(p)),
        "triangles": int(len(tris)),
        "structural_edges": int(len(se)),
        "grid_edges": int(len(ge)),
        "bytes": OUT.stat().st_size,
        "bounds": {"min": vmin.tolist(), "max": vmax.tolist()},
    }
    META.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(p):,} verts, {len(tris):,} tris, "
          f"{len(se):,} + {len(ge):,} edges, {meta['bytes'] / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
