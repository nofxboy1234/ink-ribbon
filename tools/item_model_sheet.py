#!/usr/bin/env python3
"""Lay the rendered item models into labelled contact sheets.

Run after ``blender -b -P tools/render_item_models.py``:
    uv run --with pillow python tools/item_model_sheet.py
"""

from __future__ import annotations

import json
import pathlib

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
VERIFY = ROOT / "verification" / "item_models"
REPORT = VERIFY / "report.json"
COLUMNS = 6
ROWS = 4
CELL = 210
HEADER = 38


def font(size: int) -> ImageFont.ImageFont:
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    ):
        if pathlib.Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def main() -> None:
    report = json.loads(REPORT.read_text(encoding="utf-8"))
    entries = report["report"]
    small = font(11)
    pages = (len(entries) + COLUMNS * ROWS - 1) // (COLUMNS * ROWS)
    for stale in VERIFY.glob("contact-*.png"):
        stale.unlink()
    for page in range(pages):
        chunk = entries[page * COLUMNS * ROWS : (page + 1) * COLUMNS * ROWS]
        sheet = Image.new(
            "RGB", (COLUMNS * CELL, ROWS * (CELL + HEADER)), (228, 230, 235)
        )
        draw = ImageDraw.Draw(sheet)
        for index, entry in enumerate(chunk):
            column = index % COLUMNS
            row = index // COLUMNS
            x = column * CELL
            y = row * (CELL + HEADER)
            image = Image.open(ROOT / entry["image"]).convert("RGBA")
            background = Image.new("RGBA", image.size, (228, 230, 235, 255))
            background.alpha_composite(image)
            background = background.convert("RGB")
            background.thumbnail((CELL - 8, CELL - 8), Image.Resampling.LANCZOS)
            sheet.paste(
                background,
                (x + (CELL - background.width) // 2, y + HEADER),
            )
            draw.text((x + 4, y + 3), entry["id"][:34], fill=(20, 20, 25), font=small)
            draw.text(
                (x + 4, y + 15),
                entry["title"][:36],
                fill=(70, 70, 80),
                font=small,
            )
            draw.text(
                (x + 4, y + 27),
                entry["status"],
                fill=(110, 110, 120),
                font=small,
            )
        target = VERIFY / f"contact-{page + 1}.png"
        sheet.save(target)
        print(f"wrote {target.relative_to(ROOT)} ({len(chunk)} models)")


if __name__ == "__main__":
    main()
