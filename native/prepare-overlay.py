#!/usr/bin/env python3
"""Build the Floor 1 map overlay texture for the Sokol map.

Composites the hand-traced layers into one raw RGBA texture, each keeping its
Dracula colour:

    walls            #f1fa8c  Dracula yellow
    obstacles        #ff79c6  Dracula pink
    locked_doors     #ff5555  Dracula red
    unknown_doors    #44475a  Dracula comment
    unlocked_doors   #8be9fd  Dracula cyan
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
    "care-center-full-walls.png",
    "care-center-full-obstacles.png",
    "care-center-full-locked_doors.png",
    "care-center-full-unknown_doors.png",
    "care-center-full-unlocked_doors.png",
]


def main() -> None:
    canvas = None
    for name in LAYERS:
        layer = Image.open(ORIGINALS / name).convert("RGBA").crop(CROP)
        height = round(layer.height * WIDTH / layer.width)
        layer = layer.resize((WIDTH, height), Image.Resampling.LANCZOS)
        if canvas is None:
            canvas = Image.new("RGBA", (WIDTH, height), (0, 0, 0, 0))
        canvas.alpha_composite(layer)

    assert canvas is not None
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(canvas.tobytes())
    print(
        f"Wrote {OUTPUT.relative_to(ROOT)} "
        f"({WIDTH}x{canvas.height}, {OUTPUT.stat().st_size} bytes)"
    )


if __name__ == "__main__":
    main()
