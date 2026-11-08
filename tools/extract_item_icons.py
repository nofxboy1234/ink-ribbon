#!/usr/bin/env python3
"""Extract the RE2 map and item icon set into a sokol-ready atlas.

Retail `.tex` files are written to ``data/raw/item_icons`` (gitignored). The
derived output is ``public/rpd/icons/`` plus ``icons_atlas.png`` and
``icons.json``.

Run:
    uv run --with zstandard --with texture2ddecoder --with pillow \
        python tools/extract_item_icons.py
"""

from __future__ import annotations

import argparse
import json
import pathlib
import struct
import sys

from PIL import Image, ImageChops

import re_pak
import tex

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCES = ROOT / "tools" / "item_icon_sources.json"
RAW = ROOT / "data" / "raw" / "item_icons"
OUT = ROOT / "public" / "rpd"
ICONS = OUT / "icons"

UVS_COUNT_AT = 0x0C
UVS_TABLE_AT = 0x28
UVS_ENTRY_SIZE = 32


def sprite_rect(uvs: bytes, index: int, width: int, height: int) -> tuple[int, int, int, int]:
    count = struct.unpack_from("<I", uvs, UVS_COUNT_AT)[0]
    table = struct.unpack_from("<Q", uvs, UVS_TABLE_AT)[0]
    if not 0 <= index < count:
        raise ValueError(f"sprite {index} outside 0..{count - 1}")
    _a, flag, u0, v0, u1, v1, _c, _e = struct.unpack_from(
        "<IIffffII", uvs, table + index * UVS_ENTRY_SIZE
    )
    if flag != 0:
        raise ValueError(f"sprite {index} is a nine-slice, not an icon")
    rect = (round(u0 * width), round(v0 * height), round(u1 * width), round(v1 * height))
    if rect[2] <= rect[0] or rect[3] <= rect[1]:
        raise ValueError(f"sprite {index} has an empty rect {rect}")
    return rect


def crop_source(
    img: Image.Image, source: dict, icon: dict, uvs_bytes: bytes | None
) -> tuple[Image.Image, tuple[int, int, int, int]]:
    kind = source["kind"]
    if kind == "sprite":
        if uvs_bytes is None:
            raise ValueError(f"source {source['texture']} has no UVS data")
        w, h = img.size
        rect = sprite_rect(uvs_bytes, icon["sprite"], w, h)
        return img.crop(rect), rect
    if kind == "rect":
        rect = tuple(source["rect"] if "rect" in source else icon["rect"])
        return img.crop(rect), rect
    if kind == "cell":
        inset = source.get("inset", 0)
        x0, y0, x1, y1 = icon["rect"]
        rect = (x0 + inset, y0 + inset, x1 - inset, y1 - inset)
        return img.crop(rect), tuple(icon["rect"])
    raise ValueError(f"unknown source kind {kind}")


def key_black(img: Image.Image) -> Image.Image:
    rgb = img.convert("RGB")
    r, g, b = rgb.split()
    peak = ImageChops.lighter(ImageChops.lighter(r, g), b)
    alpha = peak.point(lambda v: 0 if v <= 8 else min(255, (v - 8) * 8))
    out = rgb.copy()
    out.putalpha(alpha)
    return out


def fit_icon(img: Image.Image, size: int) -> Image.Image:
    bbox = img.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError("icon has no opaque pixels")
    img = img.crop(bbox)
    pad = 2
    limit = size - pad * 2
    scale = min(limit / img.width, limit / img.height)
    resized = img.resize(
        (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
        Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(resized, ((size - resized.width) // 2, (size - resized.height) // 2))
    return canvas


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=pathlib.Path, default=SOURCES)
    args = parser.parse_args()

    config = json.loads(args.sources.read_text(encoding="utf-8"))
    size = int(config["icon_size"])
    columns = int(config["atlas"]["columns"])

    if not re_pak.GAME_DIR.is_dir():
        sys.exit(f"RE2 install not found: {re_pak.GAME_DIR}\nset RE2_GAME_DIR")

    texture_paths = sorted({source["texture"] for source in config["sources"].values()})
    uvs_paths = sorted(
        {source["uvs"] for source in config["sources"].values() if "uvs" in source}
    )
    entries = re_pak.find(texture_paths + uvs_paths)

    RAW.mkdir(parents=True, exist_ok=True)
    for path in texture_paths + uvs_paths:
        data = re_pak.read(entries[path])
        (RAW / pathlib.Path(path).name).write_bytes(data)

    image_bytes: dict[str, bytes] = {}
    images: dict[str, Image.Image] = {}
    for source in config["sources"].values():
        path = source["texture"]
        if path in images:
            continue
        data = (RAW / pathlib.Path(path).name).read_bytes()
        decoded = tex.decode(data)
        images[path] = Image.frombytes("RGBA", (decoded.width, decoded.height), decoded.rgba)
        print(f"decoded {path} {decoded.width}x{decoded.height}")

    for source in config["sources"].values():
        if "uvs" in source:
            image_bytes[source["uvs"]] = (RAW / pathlib.Path(source["uvs"]).name).read_bytes()

    ICONS.mkdir(parents=True, exist_ok=True)
    for stale in ICONS.glob("*.png"):
        stale.unlink()

    icons: dict[str, dict] = {}
    rendered: list[tuple[str, Image.Image]] = []
    for spec in config["icons"]:
        icon_id = spec["id"]
        if icon_id in icons:
            raise ValueError(f"duplicate icon id {icon_id}")
        source = config["sources"][spec["source"]]
        crop, source_rect = crop_source(
            images[source["texture"]], source, spec, image_bytes.get(source.get("uvs"))
        )
        if source.get("key_black"):
            crop = key_black(crop)
        icon = fit_icon(crop, size)
        icon.save(ICONS / f"{icon_id}.png")
        icons[icon_id] = {
            "source": source["texture"],
            "source_kind": source["kind"],
            "source_sprite": spec.get("sprite"),
            "source_rect": list(source_rect),
            "status": spec["status"],
            "note": spec["note"],
        }
        rendered.append((icon_id, icon))

    for category, choice in config["categories"].items():
        if choice["icon"] not in icons:
            raise ValueError(f"category {category} points at unknown icon {choice['icon']}")
    for title, icon_id in config["items"].items():
        if icon_id not in icons:
            raise ValueError(f"item {title!r} points at unknown icon {icon_id}")

    rows = (len(rendered) + columns - 1) // columns
    atlas_w = columns * size
    atlas_h = max(1, rows) * size
    atlas = Image.new("RGBA", (atlas_w, atlas_h), (0, 0, 0, 0))
    for index, (icon_id, icon) in enumerate(rendered):
        x = (index % columns) * size
        y = (index // columns) * size
        atlas.alpha_composite(icon, (x, y))
        icons[icon_id]["atlas_rect"] = [x, y, size, size]
    atlas.save(OUT / config["atlas"]["file"])

    manifest = {
        "version": 1,
        "atlas": {
            "file": config["atlas"]["file"],
            "width": atlas_w,
            "height": atlas_h,
            "cell": size,
            "columns": columns,
            "rows": rows,
        },
        "icons": icons,
        "categories": config["categories"],
        "items": config["items"],
    }
    (OUT / "icons.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")

    for icon_id, icon in icons.items():
        path = ICONS / f"{icon_id}.png"
        check = Image.open(path)
        if check.size != (size, size):
            raise SystemExit(f"{path} is {check.size}, expected {(size, size)}")
        if check.getchannel("A").getbbox() is None:
            raise SystemExit(f"{path} has no opaque pixels")
        x, y, w, h = icon["atlas_rect"]
        if atlas.crop((x, y, x + w, y + h)).tobytes() != check.tobytes():
            raise SystemExit(f"{path} does not match its atlas rect")
    print(f"verified {len(icons)} icon PNGs against the atlas")

    exact = sum(1 for icon in icons.values() if icon["status"] == "exact")
    approximate = sum(1 for icon in icons.values() if icon["status"] == "approximate")
    print(f"wrote {len(icons)} icons to {ICONS.relative_to(ROOT)}")
    print(f"wrote {atlas_w}x{atlas_h} atlas to {(OUT / config['atlas']['file']).relative_to(ROOT)}")
    print(f"definitions: {exact} exact, {approximate} approximate")
    print(f"categories: {len(config['categories'])}, item overrides: {len(config['items'])}")


if __name__ == "__main__":
    main()
