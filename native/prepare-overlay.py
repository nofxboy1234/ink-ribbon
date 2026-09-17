#!/usr/bin/env python3
"""Build the Sokol map overlays for the traced floors.

Reads the hand-traced layers straight out of the Krita source document (see
`native/kra_layers.py`) and composites each floor's layers into one raw RGBA
texture, recolouring each to the reference map palette (near-monochrome, low
contrast):

    walls            #5c6060
    stairs           #787e7e
    obstacles        #3a3a3a
    locked_doors     #a04457
    unknown_doors    #6a6a6a
    unlocked_doors   #4ea0aa

Each layer is a single-category alpha mask, so the source colours are ignored
and only the alpha channel is used. `stairs` is texture only and is never read
by the navigation/collision bake, so it stays walkable.

Output: `native/assets/floor-N-overlay.rgba` for every floor (blank until traced).
"""

from pathlib import Path

from PIL import Image

from kra_layers import SOURCE, read_floor

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "native" / "assets"

# Canonical floor frames in source-composite pixels (see artifacts/care-center/README.md).
FLOORS = {
    1: (1600, 3420, 1600 + 4750, 3420 + 2730),
    2: (1600, 1500, 1600 + 4750, 1500 + 2240),
    3: (1600, 0, 1600 + 4750, 0 + 1536),
}
WIDTH = 2048

LAYERS = [
    # Texture only; deliberately excluded from prepare-nav.py so stairs are walkable.
    ("stairs", (120, 126, 126)),
    ("walls", (92, 96, 96)),
    ("obstacles", (58, 58, 58)),
    ("locked_doors", (160, 68, 87)),
    ("unknown_doors", (106, 106, 106)),
    ("unlocked_doors", (78, 160, 170)),
]


def build(floor: int, crop: tuple[int, int, int, int]) -> None:
    canvas = None
    for category, color in LAYERS:
        layer = read_floor(floor, category, crop)
        height = round(layer.height * WIDTH / layer.width)
        layer = layer.resize((WIDTH, height), Image.Resampling.LANCZOS)
        tinted = Image.new("RGBA", (WIDTH, height), (*color, 0))
        tinted.putalpha(layer.getchannel("A"))
        if canvas is None:
            canvas = Image.new("RGBA", (WIDTH, height), (0, 0, 0, 0))
        canvas.alpha_composite(tinted)

    assert canvas is not None
    OUTPUT.mkdir(parents=True, exist_ok=True)
    path = OUTPUT / f"floor-{floor}-overlay.rgba"
    path.write_bytes(canvas.tobytes())
    print(
        f"Wrote {path.relative_to(ROOT)} "
        f"({WIDTH}x{canvas.height}, {path.stat().st_size} bytes)"
    )


def main() -> None:
    print(f"source {SOURCE.relative_to(ROOT)}")
    # Always emit every floor: the app embeds all of them, and a floor that has
    # not been traced yet is written blank so it falls back to procedural walls.
    for floor, crop in sorted(FLOORS.items()):
        build(floor, crop)


if __name__ == "__main__":
    main()
