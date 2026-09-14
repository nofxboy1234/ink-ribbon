#!/usr/bin/env python3
"""Bake the Sokol map text font atlas from a TrueType face.

The reference HUD uses a humanist sans; Open Sans is a close match. Emits a
white-on-transparent RGBA atlas plus a small binary metrics header:

    u16 atlas_w, atlas_h, cell_w, cell_h, ascent, first_char, char_count, pad
    char_count * u16 advances (pixels at the baked size)
"""

import struct
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
FONT_PATH = Path("/usr/share/fonts/open-sans/OpenSans-Regular.ttf")
SIZE = 48
FIRST, LAST = 32, 126
COLS = 16
PAD = 2

OUT_RGBA = ROOT / "native" / "assets" / "font.rgba"
OUT_BIN = ROOT / "native" / "assets" / "font.bin"


def main() -> None:
    font = ImageFont.truetype(str(FONT_PATH), SIZE)
    ascent, descent = font.getmetrics()
    cell_h = ascent + descent
    chars = [chr(c) for c in range(FIRST, LAST + 1)]

    advances = []
    max_width = 0
    for ch in chars:
        advances.append(round(font.getlength(ch)))
        bbox = font.getbbox(ch)
        if bbox:
            max_width = max(max_width, bbox[2] - bbox[0])

    cell_w = max_width + PAD * 2
    rows = (len(chars) + COLS - 1) // COLS
    atlas_w, atlas_h = COLS * cell_w, rows * cell_h

    alpha = Image.new("L", (atlas_w, atlas_h), 0)
    draw = ImageDraw.Draw(alpha)
    for i, ch in enumerate(chars):
        col, row = i % COLS, i // COLS
        draw.text((col * cell_w + PAD, row * cell_h), ch, fill=255, font=font)

    rgba = Image.new("RGBA", (atlas_w, atlas_h), (255, 255, 255, 0))
    rgba.putalpha(alpha)
    OUT_RGBA.parent.mkdir(parents=True, exist_ok=True)
    OUT_RGBA.write_bytes(rgba.tobytes())

    header = struct.pack(
        "<HHHHHHHH", atlas_w, atlas_h, cell_w, cell_h, ascent, FIRST, len(chars), PAD
    )
    OUT_BIN.write_bytes(header + b"".join(struct.pack("<H", a) for a in advances))

    print(
        f"Wrote {OUT_RGBA.relative_to(ROOT)} ({atlas_w}x{atlas_h}) and "
        f"{OUT_BIN.relative_to(ROOT)}"
    )


if __name__ == "__main__":
    main()
