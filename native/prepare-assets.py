#!/usr/bin/env python3
"""Build the shared Sokol map textures from the golden map reference.

The source room artwork is kept at its original pixels until the final, single
resize to the 2048px runtime width. The HUD texture is a frame from the
provided reference video with only the map viewport and controls that Rust
updates dynamically made transparent. It is rendered by Sokol, never React.
"""

from pathlib import Path
import subprocess
import tempfile

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
CARE = ROOT / "artifacts" / "care-center"
WEB = ROOT / "web" / "public" / "maps" / "transparent"
NATIVE = ROOT / "native" / "assets"
VIDEO = ROOT / "artifacts" / "interactive-map.mp4"

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


def build_reference_hud() -> None:
    if not VIDEO.exists():
        raise FileNotFoundError(VIDEO)

    with tempfile.TemporaryDirectory(prefix="ink-ribbon-map-") as temporary:
        frame = Path(temporary) / "reference.png"
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                "5",
                "-i",
                str(VIDEO),
                "-frames:v",
                "1",
                str(frame),
            ],
            check=True,
        )
        hud = Image.open(frame).convert("RGBA")
        draw = ImageDraw.Draw(hud)

        # The map texture, floor selector, zoom selector, and the reference
        # Close control are stateful Rust-rendered layers. Clearing these
        # regions lets the shared grid show through beneath them.
        for box in [
            (266, 228, 1653, 948),  # map viewport
            (220, 450, 266, 720),  # floor selector
            (1653, 350, 1700, 840),  # zoom selector
            (1320, 1015, 1535, 1080),  # removed Close legend item
        ]:
            draw.rectangle(box, fill=(0, 0, 0, 0))

        raw_rgba(NATIVE / "map-hud.rgba", hud)


def main() -> None:
    subprocess.run(["/usr/bin/python3", str(CARE / "remove-grid.py")], check=True)
    build_room_layers()
    build_reference_hud()
    print("Generated cleaned room layers, native RGBA textures, and map HUD.")


if __name__ == "__main__":
    main()
