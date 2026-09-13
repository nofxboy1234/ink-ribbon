#!/usr/bin/env python3
"""Build the shared Sokol room textures from the care center artwork.

The three above-ground floors are cut from the hand-authored
`originals/care-center-full-premult.png`, which carries the corrected alpha
channel for those floors. The basement is cut from the cleaned artwork and the
foreground mask. Each source keeps its original pixels until the single resize
to the 2048px runtime width. Sokol renders the grid, room layers, and all map
interactions; React only provides the surrounding web shell.
"""

from pathlib import Path
import subprocess

from PIL import Image, ImageChops


ROOT = Path(__file__).resolve().parents[1]
CARE = ROOT / "artifacts" / "care-center"
ORIGINALS = CARE / "originals"
WEB = ROOT / "web" / "public" / "maps" / "transparent"
NATIVE = ROOT / "native" / "assets"
PREMULT = ORIGINALS / "care-center-full-premult.png"
FLOORS = {
    "floor-3": (1600, 0, 6350, 1536),
    "floor-2": (1600, 1500, 6350, 3740),
    "floor-1": (1600, 3420, 6350, 6150),
    "basement": (1600, 6200, 6350, 8192),
}
# The premultiplied matte only covers the above-ground floors; the basement has
# no alpha there and is rebuilt from the cleaned artwork below.
MATTE_FLOORS = ("floor-3", "floor-2", "floor-1")


def raw_rgba(path: Path, image: Image.Image) -> None:
    path.write_bytes(image.convert("RGBA").tobytes())


def is_premultiplied(image: Image.Image) -> bool:
    """Whether every color channel stays within its alpha (premultiplied)."""
    alpha = image.getchannel("A")
    return not any(
        ImageChops.subtract(channel, alpha).getextrema()[1]
        for channel in image.split()[:3]
    )


def un_premultiply(image: Image.Image) -> Image.Image:
    """Recover straight RGBA from premultiplied RGBA for Sokol's blend mode."""
    red, green, blue, alpha = image.split()
    alpha_bytes = alpha.tobytes()
    channels = []
    for channel in (red, green, blue):
        values = channel.tobytes()
        straight = bytes(
            0 if value == 0 else min(255, (sample * 255 + value // 2) // value)
            for sample, value in zip(values, alpha_bytes)
        )
        channels.append(Image.frombytes("L", image.size, straight))
    return Image.merge("RGBA", (*channels, alpha))


def build_room_layers() -> None:
    source = Image.open(CARE / "care-center-full.png").convert("RGB")
    mask = Image.open(CARE / "foreground-mask.png").convert("L")
    matte = Image.open(PREMULT).convert("RGBA")
    matte_premultiplied = is_premultiplied(matte)
    WEB.mkdir(parents=True, exist_ok=True)
    NATIVE.mkdir(parents=True, exist_ok=True)

    for name, box in FLOORS.items():
        if name in MATTE_FLOORS:
            crop = matte.crop(box)
        else:
            crop = source.crop(box).convert("RGBA")
            crop.putalpha(mask.crop(box))
        width = 2048
        height = round(crop.height * width / crop.width)
        runtime = crop.resize((width, height), Image.Resampling.LANCZOS)
        if name in MATTE_FLOORS and matte_premultiplied:
            runtime = un_premultiply(runtime)
        runtime.save(WEB / f"{name}.png", optimize=True)
        raw_rgba(NATIVE / f"{name}.rgba", runtime)


def main() -> None:
    subprocess.run(["/usr/bin/python3", str(CARE / "remove-grid.py")], check=True)
    build_room_layers()
    print("Generated cleaned room layers and native RGBA textures.")


if __name__ == "__main__":
    main()
