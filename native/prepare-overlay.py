#!/usr/bin/env python3
"""Build the Floor 1 map overlay texture for the Sokol map.

Composites the hand-traced layers into one raw RGBA texture and recolours each
to the reference map palette (near-monochrome, low contrast):

    walls            #5c6060
    obstacles        #3a3a3a
    locked_doors     #a04457
    unknown_doors    #6a6a6a
    unlocked_doors   #4ea0aa

Each layer is a single-category alpha mask, so the source colours are ignored
and only the alpha channel is used.
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ORIGINALS = ROOT / "artifacts" / "care-center" / "originals"
OUTPUT = ROOT / "native" / "assets" / "floor-1-overlay.rgba"

# Canonical Floor 1 frame in source pixels (see artifacts/care-center/README.md).
CROP = (1600, 3420, 1600 + 4750, 3420 + 2730)
WIDTH = 2048

LAYERS = [
    ("care-center-full-walls.png", (92, 96, 96)),
    ("care-center-full-obstacles.png", (58, 58, 58)),
    ("care-center-full-locked_doors.png", (160, 68, 87)),
    ("care-center-full-unknown_doors.png", (106, 106, 106)),
    ("care-center-full-unlocked_doors.png", (78, 160, 170)),
]


def main() -> None:
    canvas = None
    for name, color in LAYERS:
        layer = Image.open(ORIGINALS / name).convert("RGBA").crop(CROP)
        height = round(layer.height * WIDTH / layer.width)
        layer = layer.resize((WIDTH, height), Image.Resampling.LANCZOS)
        tinted = Image.new("RGBA", (WIDTH, height), (*color, 0))
        tinted.putalpha(layer.getchannel("A"))
        if canvas is None:
            canvas = Image.new("RGBA", (WIDTH, height), (0, 0, 0, 0))
        canvas.alpha_composite(tinted)

    assert canvas is not None
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(canvas.tobytes())
    print(
        f"Wrote {OUTPUT.relative_to(ROOT)} "
        f"({WIDTH}x{canvas.height}, {OUTPUT.stat().st_size} bytes)"
    )


if __name__ == "__main__":
    main()
