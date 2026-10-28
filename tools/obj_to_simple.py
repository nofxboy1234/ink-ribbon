#!/usr/bin/env python3
"""Convert a Blender blockout OBJ into the RPDW v3 renderer asset."""
from __future__ import annotations

import argparse
import json
import pathlib
import struct

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
COLOURS = {
    "simple_floor": (142, 142, 142),
    "simple_wall": (97, 97, 97),
    "simple_column": (163, 163, 163),
    "simple_stair": (128, 128, 128),
    "simple_trim": (184, 184, 184),
    "simple_plinth": (79, 79, 79),
    "Blockout_Floor": (190, 190, 190),
    "Blockout_Wall": (135, 135, 135),
    "Blockout_Pillar": (205, 205, 205),
    "Blockout_Stair": (162, 162, 162),
    "Blockout_Ramp": (172, 172, 172),
}


def convert(
    obj_path: pathlib.Path,
    out: pathlib.Path,
    meta: pathlib.Path,
    method: str,
    pad: float = 0.0,
):
    verts = []
    faces = []  # (vertex indices, colour)
    material = "simple_floor"
    for line in obj_path.read_text().splitlines():
        if line.startswith("usemtl "):
            material = line[7:].strip()
        elif line.startswith("v "):
            verts.append(tuple(float(x) for x in line.split()[1:4]))
        elif line.startswith("f "):
            idx = [int(x.split("/")[0]) - 1 for x in line.split()[1:]]
            for i in range(1, len(idx) - 1):
                faces.append(
                    (
                        (idx[0], idx[i], idx[i + 1]),
                        COLOURS.get(material, (140, 140, 140)),
                    )
                )

    p = np.asarray(verts, dtype=np.float64)
    origin = p.min(axis=0)
    extent = float((p.max(axis=0) - origin).max())
    scale = extent / 65535.0 if extent > 1e-6 else 1.0
    q = np.clip(np.rint((p - origin) / scale), 0, 65535).astype("<u2")
    idx = np.asarray([f[0] for f in faces], dtype="<u2").reshape(-1)
    # Colours are per triangle corner; rebuild one colour per vertex by taking
    # the colour of the first face that uses the vertex.
    vcol = np.zeros((len(p), 3), dtype="u1")
    seen = np.zeros(len(p), dtype=bool)
    for (a, b, c), col in faces:
        for i in (a, b, c):
            if not seen[i]:
                vcol[i] = col
                seen[i] = True
    flatcol = vcol.reshape(-1)

    y0, y1 = float(p[:, 1].min()), float(p[:, 1].max())
    minb = (p.min(axis=0) - pad).astype("<f4")
    maxb = (p.max(axis=0) + pad).astype("<f4")
    geom_min, geom_max = p.min(axis=0), p.max(axis=0)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("wb") as f:
        f.write(b"RPDW")
        f.write(struct.pack("<IIIIII", 3, 1, len(p), len(idx) // 3, 3, 0))
        f.write(minb.tobytes())
        f.write(maxb.tobytes())
        f.write(struct.pack("<IIff", 0, 1, y0, y1))
        f.write(struct.pack("<IIff", 0, 0, 0.0, 0.0))
        f.write(struct.pack("<IIff", 0, 0, 0.0, 0.0))
        f.write(struct.pack("<IIII", len(p), len(idx), 0, 0))
        f.write(struct.pack("<3f", *origin.astype("<f4")))
        f.write(struct.pack("<f", scale))
        f.write(q.tobytes())
        f.write(flatcol.tobytes())
        f.write(idx.tobytes())
        while f.tell() % 4:
            f.write(b"\0")
    meta.parent.mkdir(parents=True, exist_ok=True)
    meta.write_text(
        json.dumps(
            {
                "asset": out.name,
                "version": 3,
                "method": method,
                "vertices": int(len(p)),
                "triangles": int(len(idx) // 3),
                "bytes": out.stat().st_size,
                "bounds": {"min": minb.tolist(), "max": maxb.tolist()},
                "geometry_bounds": {
                    "min": geom_min.tolist(),
                    "max": geom_max.tolist(),
                },
            },
            indent=2,
        )
        + "\n"
    )
    try:
        label = out.relative_to(ROOT)
    except ValueError:
        label = out
    print(f"wrote {label}: {len(p)} verts, {len(idx)//3} tris")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--obj", default=str(ROOT / "build/simple.obj"))
    parser.add_argument("--out", default=str(ROOT / "public/rpd/simple.bin"))
    parser.add_argument("--meta", default=str(ROOT / "public/rpd/simple.json"))
    parser.add_argument("--method", default="Blender simplified entrance")
    parser.add_argument("--pad", type=float, default=0.0)
    args = parser.parse_args()
    convert(
        pathlib.Path(args.obj),
        pathlib.Path(args.out),
        pathlib.Path(args.meta),
        args.method,
        args.pad,
    )


if __name__ == "__main__":
    main()
