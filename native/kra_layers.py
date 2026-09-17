#!/usr/bin/env python3
"""Read hand-traced layers directly out of the Krita source document.

A `.kra` is a zip of per-layer tile streams. Rather than exporting PNGs from
Krita by hand, the prepare scripts read the layers they need from `SOURCE`:

  - `maindoc.xml` maps a layer name to its `Unnamed/layers/layerN` file.
  - Each layer file starts with `VERSION 2 / TILEWIDTH / TILEHEIGHT /
    PIXELSIZE / DATA <tiles>` and then one `x,y,compression,size` header per
    stored tile, followed by that many bytes.
  - Each tile is prefixed with a 1-byte flag (1 = LZF, 0 = raw) and, when
    compressed, an LZF stream. Uncompressed bytes are planar by channel in
    B, G, R, A order.
  - Only tiles that contain data are stored; anything not covered is fully
    transparent.
"""

import re
import zipfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "artifacts" / "care-center" / "originals" / "care-center-full-v2.kra"

CATEGORIES = {
    "walls",
    "obstacles",
    "locked_doors",
    "unlocked_doors",
    "unknown_doors",
    "stairs",
}


def _lzf_decompress(data: bytes, expected: int) -> bytes:
    out = bytearray()
    i = 0
    n = len(data)
    while i < n and len(out) < expected:
        ctrl = data[i]
        i += 1
        if ctrl < 32:
            length = min(ctrl + 1, expected - len(out))
            out += data[i : i + length]
            i += ctrl + 1
        else:
            length = ctrl >> 5
            if length == 7:
                length += data[i]
                i += 1
            ref = len(out) - ((ctrl & 0x1F) << 8) - data[i] - 1
            i += 1
            for _ in range(length + 2):
                if len(out) >= expected:
                    break
                out.append(out[ref])
                ref += 1
    if len(out) != expected:
        raise ValueError(f"lzf decoded {len(out)} bytes, expected {expected}")
    return bytes(out)


def layer_names(kra: Path = SOURCE) -> set[str]:
    with zipfile.ZipFile(kra) as z:
        maindoc = z.read("maindoc.xml").decode("utf-8", "replace")
    return set(re.findall(r'<layer\b[^>]*\bname="([^"]+)"', maindoc))


def resolve_layer(floor: int, category: str, kra: Path = SOURCE) -> str:
    """Find the layer tracing `category` for `floor` (1, 2 or 3)."""
    if category not in CATEGORIES:
        raise ValueError(f"unknown category {category!r}")
    names = layer_names(kra)
    for candidate in (f"floor_{floor}_{category}", f"floor{floor}_{category}"):
        if candidate in names:
            return candidate
    raise KeyError(
        f"no layer for floor {floor} {category} (looked for {floor}_{category})"
    )


def has_floor(floor: int, kra: Path = SOURCE) -> bool:
    """A floor exists as soon as it has a walls trace; the other categories are
    optional and read as blank when absent."""
    names = layer_names(kra)
    return f"floor_{floor}_walls" in names or f"floor{floor}_walls" in names


def _layer_info(z: zipfile.ZipFile, layer_name: str) -> tuple[str, int, int]:
    """Return (filename, offset_x, offset_y) for a named layer.

    Tile coordinates in the layer stream are relative to the layer's own origin;
    Krita stores the layer's canvas placement as the x/y offset on the tag, so a
    moved layer (e.g. dragged with the Move tool) must be shifted by it.
    """
    maindoc = z.read("maindoc.xml").decode("utf-8", "replace")
    for m in re.finditer(r"<layer\b[^>]*>", maindoc):
        tag = m.group(0)
        name = re.search(r'\bname="([^"]+)"', tag)
        if name is None or name.group(1) != layer_name:
            continue
        filename = re.search(r'\bfilename="([^"]+)"', tag)
        offset_x = re.search(r'\bx="(-?\d+)"', tag)
        offset_y = re.search(r'\by="(-?\d+)"', tag)
        return (
            filename.group(1) if filename else "",
            int(offset_x.group(1)) if offset_x else 0,
            int(offset_y.group(1)) if offset_y else 0,
        )
    raise KeyError(f"layer {layer_name!r} not found")


def read_layer_crop(
    layer_name: str, box: tuple[int, int, int, int], kra: Path = SOURCE
) -> Image.Image:
    """Decode one layer, returning only the requested source-pixel box (RGBA)."""
    bx, by, br, bb = box
    cw, ch = br - bx, bb - by
    with zipfile.ZipFile(kra) as z:
        filename, offset_x, offset_y = _layer_info(z, layer_name)
        raw = z.read(f"Unnamed/layers/{filename}")

    header = re.match(
        rb"VERSION 2\nTILEWIDTH (\d+)\nTILEHEIGHT (\d+)\nPIXELSIZE (\d+)\nDATA (\d+)\n",
        raw,
    )
    if header is None:
        raise ValueError(f"{layer_name}: unsupported layer header")
    tw, th, ps, count = map(int, header.groups())
    if ps != 4:
        raise ValueError(f"{layer_name}: unsupported PIXELSIZE {ps}")
    pos = header.end()
    buf = bytearray(cw * ch * 4)
    tile_bytes = tw * th * ps
    plane = tw * th
    for _ in range(count):
        end = raw.index(b"\n", pos)
        tx, ty, comp, size = raw[pos:end].decode().split(",")
        # Tile coordinates are layer-local; place them on the canvas.
        tx = int(tx) + offset_x
        ty = int(ty) + offset_y
        size = int(size)
        pos = end + 1
        blob = raw[pos : pos + size]
        pos += size
        if blob[0] == 1 and comp == "LZF":
            planar = _lzf_decompress(blob[1:], tile_bytes)
        else:
            planar = blob[1 : tile_bytes + 1]
        data = bytearray(tile_bytes)
        for n in range(plane):
            data[n * 4 + 0] = planar[2 * plane + n]
            data[n * 4 + 1] = planar[1 * plane + n]
            data[n * 4 + 2] = planar[0 * plane + n]
            data[n * 4 + 3] = planar[3 * plane + n]
        # Copy only the part of this tile that lands inside the crop box.
        x0, y0 = max(tx, bx), max(ty, by)
        x1, y1 = min(tx + tw, br), min(ty + th, bb)
        if x0 >= x1 or y0 >= y1:
            continue
        run = (x1 - x0) * 4
        for y in range(y0, y1):
            src = ((y - ty) * tw + (x0 - tx)) * 4
            dst = ((y - by) * cw + (x0 - bx)) * 4
            buf[dst : dst + run] = data[src : src + run]
    return Image.frombytes("RGBA", (cw, ch), bytes(buf))


def read_floor(floor: int, category: str, box: tuple[int, int, int, int]) -> Image.Image:
    """Decode a floor's category layer, or a blank crop when it isn't traced."""
    try:
        name = resolve_layer(floor, category)
    except KeyError:
        return Image.new("RGBA", (box[2] - box[0], box[3] - box[1]), (0, 0, 0, 0))
    return read_layer_crop(name, box)
