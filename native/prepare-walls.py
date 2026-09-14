#!/usr/bin/env python3
"""Build the floor 1 wall overlay texture for the Sokol map.

The hand-traced wall art lives in
`artifacts/care-center/originals/care-center-full-walls.png` (Dracula yellow
`#f1fa8c` line art on a transparent 8192x8192 canvas, Floor 1 only). Sokol
needs raw RGBA, so this crops the canonical Floor 1 frame and downscales it to
a runtime-friendly width, matching the previous room-texture pipeline.
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "artifacts" / "care-center" / "originals" / "care-center-full-walls.png"
OUTPUT = ROOT / "native" / "assets" / "floor-1-walls.rgba"

# Canonical Floor 1 frame in source pixels (see artifacts/care-center/README.md).
CROP = (1600, 3420, 1600 + 4750, 3420 + 2730)
WIDTH = 2048


def main() -> None:
    image = Image.open(SOURCE).convert("RGBA").crop(CROP)
    height = round(image.height * WIDTH / image.width)
    runtime = image.resize((WIDTH, height), Image.Resampling.LANCZOS)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(runtime.tobytes())
    print(f"Wrote {OUTPUT.relative_to(ROOT)} ({WIDTH}x{height}, {OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
