#!/usr/bin/env python3
"""Compose the source and blockout comparison renders side by side."""
from __future__ import annotations

import pathlib

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "build/blockout/compare"
VIEWS = [
    "f1_main_hall",
    "f1_hall_stairs",
    "f1_west_office",
    "f1_east_corridor",
    "f1_press_room",
    "f1_west_corridor",
    "f2_west",
    "f2_east",
    "f2_west_407",
    "f2_main_hall",
    "f3_west",
    "f3_east",
]


def label(image, text):
    bar = Image.new("RGB", (image.width, 28), (14, 15, 17))
    draw = ImageDraw.Draw(bar)
    draw.text((10, 7), text, fill=(220, 228, 238))
    out = Image.new("RGB", (image.width, image.height + 28), (14, 15, 17))
    out.paste(bar, (0, 0))
    out.paste(image, (0, 28))
    return out


def main():
    for name in VIEWS:
        source = Image.open(OUT / f"{name}_source.png").convert("RGB")
        blockout = Image.open(OUT / f"{name}_blockout.png").convert("RGB")
        source = label(source, "source")
        blockout = label(blockout, "blockout")
        combined = Image.new(
            "RGB", (source.width + blockout.width, source.height), (14, 15, 17)
        )
        combined.paste(source, (0, 0))
        combined.paste(blockout, (source.width, 0))
        combined.save(OUT / f"{name}.png")
        overlay = Image.blend(source, blockout, 0.5)
        overlay.save(OUT / f"{name}_overlay.png")
        print(f"composed {name}")


if __name__ == "__main__":
    main()
