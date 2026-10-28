#!/usr/bin/env python3
"""Extract the RPD statue and crashed-helicopter gimmick meshes from the PAK."""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import re_pak

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "data/raw/props"
ASSETS = {
    "sm41_024_newpolicestatue01a": "natives/stm/objectroot/setmodel/sm4x_gimmick/sm41/sm41_024_newpolicestatue01a/sm41_024_newpolicestatue01a_00md.mesh.2109108288",
    "sm46_011_crashheli01a": "natives/stm/objectroot/setmodel/sm4x_gimmick/sm46/sm46_011_crashheli01a/sm46_011_crashheli01a_00md.mesh.2109108288",
}
OUT.mkdir(parents=True, exist_ok=True)
entries = re_pak.find(list(ASSETS.values()))
for name, path in ASSETS.items():
    data = re_pak.read(entries[path])
    (OUT / f"{name}.mesh").write_bytes(data)
    print(f"wrote {name}.mesh ({len(data):,} bytes)")
