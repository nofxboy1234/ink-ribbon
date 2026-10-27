#!/usr/bin/env python3
"""Extract the RPD floors 1-3 terrain meshes from the RE2 RT PAK.

Meshes are written to data/raw/rpd/<room>.mesh. They are game assets and stay
out of git; only the derived wireframe scene is checked in.
"""

from __future__ import annotations

import pathlib
import sys

import re_pak

ROOT = pathlib.Path(__file__).resolve().parent.parent
PATH_LIST = ROOT / "tools" / "rpd_floor_meshes.txt"
OUT = ROOT / "data" / "raw" / "rpd"


def main() -> None:
    paths = [
        line.strip()
        for line in PATH_LIST.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]
    if not re_pak.GAME_DIR.is_dir():
        sys.exit(f"RE2 install not found: {re_pak.GAME_DIR}\nset RE2_GAME_DIR")
    entries = re_pak.find(paths)
    OUT.mkdir(parents=True, exist_ok=True)
    total = 0
    for path in paths:
        entry = entries[path]
        data = re_pak.read(entry)
        room = pathlib.Path(path).parent.name
        dest = OUT / f"{room}.mesh"
        dest.write_bytes(data)
        total += len(data)
        print(f"{room:12s} {len(data) / 1e6:7.2f} MB")
    print(f"extracted {len(paths)} meshes, {total / 1e6:.1f} MB -> {OUT}")


if __name__ == "__main__":
    main()
