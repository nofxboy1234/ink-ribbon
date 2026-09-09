#!/usr/bin/env python3
"""Build the shared Sokol room textures from the cleaned care center artwork.

The source room artwork is kept at its original pixels until the final, single
resize to the 2048px runtime width. Sokol renders the grid, room layers, and
all map interactions; React only provides the surrounding web shell.
"""

from pathlib import Path
import subprocess

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
CARE = ROOT / "artifacts" / "care-center"
WEB = ROOT / "web" / "public" / "maps" / "transparent"
NATIVE = ROOT / "native" / "assets"
FLOORS = {
    "floor-3": (1600, 0, 6350, 1536),
    "floor-2": (1600, 1500, 6350, 3740),
    "floor-1": (1600, 3420, 6350, 6150),
    "basement": (1600, 6200, 6350, 8192),
}


def raw_rgba(path: Path, image: Image.Image) -> None:
    path.write_bytes(image.convert("RGBA").tobytes())


def build_room_layers() -> None:
    source = Image.open(CARE / "care-center-full.png").convert("RGB")
    mask = Image.open(CARE / "foreground-mask.png").convert("L")
    WEB.mkdir(parents=True, exist_ok=True)
    NATIVE.mkdir(parents=True, exist_ok=True)

    for name, box in FLOORS.items():
        crop = source.crop(box).convert("RGBA")
        crop.putalpha(mask.crop(box))
        width = 2048
        height = round(crop.height * width / crop.width)
        runtime = crop.resize((width, height), Image.Resampling.LANCZOS)
        runtime.save(WEB / f"{name}.png", optimize=True)
        raw_rgba(NATIVE / f"{name}.rgba", runtime)


def main() -> None:
    subprocess.run(["/usr/bin/python3", str(CARE / "remove-grid.py")], check=True)
    build_room_layers()
    print("Generated cleaned room layers and native RGBA textures.")


if __name__ == "__main__":
    main()
