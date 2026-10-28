#!/usr/bin/env python3
"""Convert the Blender simple-hall OBJ into the RPDW v3 renderer asset."""
from __future__ import annotations
import array, json, pathlib, struct
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
OBJ = ROOT / "build/simple.obj"
OUT = ROOT / "public/rpd/simple.bin"
META = ROOT / "public/rpd/simple.json"
COLOURS = {
    "simple_floor": (142, 142, 142),
    "simple_wall": (97, 97, 97),
    "simple_column": (163, 163, 163),
    "simple_stair": (128, 128, 128),
    "simple_trim": (184, 184, 184),
    "simple_plinth": (79, 79, 79),
}

verts = []
faces = []  # (vertex indices, colour)
material = "simple_floor"
for line in OBJ.read_text().splitlines():
    if line.startswith("usemtl "):
        material = line[7:].strip()
    elif line.startswith("v "):
        verts.append(tuple(float(x) for x in line.split()[1:4]))
    elif line.startswith("f "):
        idx = [int(x.split("/")[0]) - 1 for x in line.split()[1:]]
        for i in range(1, len(idx) - 1):
            faces.append(((idx[0], idx[i], idx[i + 1]), COLOURS.get(material, (140, 140, 140))))

p = np.asarray(verts, dtype=np.float64)
origin = p.min(axis=0)
extent = float((p.max(axis=0) - origin).max())
scale = extent / 65535.0 if extent > 1e-6 else 1.0
q = np.clip(np.rint((p - origin) / scale), 0, 65535).astype("<u2")
idx = np.asarray([f[0] for f in faces], dtype="<u2").reshape(-1)
cols = np.asarray([f[1] for f in faces for _ in range(3)], dtype="u1")
# colours are per triangle corner; rebuild one colour per vertex by taking the
# colour of the first face that uses the vertex.
vcol = np.zeros((len(p), 3), dtype="u1")
seen = np.zeros(len(p), dtype=bool)
for (a, b, c), col in faces:
    for i in (a, b, c):
        if not seen[i]:
            vcol[i] = col; seen[i] = True
flatcol = vcol.reshape(-1)

y0, y1 = float(p[:, 1].min()), float(p[:, 1].max())
minb, maxb = p.min(axis=0).astype("<f4"), p.max(axis=0).astype("<f4")
with OUT.open("wb") as f:
    f.write(b"RPDW")
    f.write(struct.pack("<IIIIII", 3, 1, len(p), len(idx) // 3, 3, 0))
    f.write(minb.tobytes()); f.write(maxb.tobytes())
    f.write(struct.pack("<IIff", 0, 1, y0, y1))
    f.write(struct.pack("<IIff", 0, 0, 0.0, 0.0))
    f.write(struct.pack("<IIff", 0, 0, 0.0, 0.0))
    f.write(struct.pack("<IIII", len(p), len(idx), 0, 0))
    f.write(struct.pack("<3f", *origin.astype("<f4")))
    f.write(struct.pack("<f", scale))
    f.write(q.tobytes()); f.write(flatcol.tobytes()); f.write(idx.tobytes())
    while f.tell() % 4:
        f.write(b"\0")
meta = {"asset": OUT.name, "version": 3, "method": "Blender simplified entrance",
        "vertices": int(len(p)), "triangles": int(len(idx)//3),
        "bytes": OUT.stat().st_size,
        "bounds": {"min": minb.tolist(), "max": maxb.tolist()}}
META.write_text(json.dumps(meta, indent=2) + "\n")
print(f"wrote {OUT}: {len(p)} verts, {len(idx)//3} tris")
