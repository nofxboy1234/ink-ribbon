#!/usr/bin/env python3
"""Bake the key item placements from the `item_*` layers of the Krita source.

Each `item_*` layer holds one circle marker; its layer name (minus the prefix)
is the item's display label. This decodes the layer, finds the single mark,
assigns it to the floor whose art frame contains it (deepest containment, so a
mark sitting in the overlapping F1/F2 band resolves to the floor it is most
inside) and writes `native/assets/items.bin`:

    header: u32 LE count
    record: u32 LE floor, f32 LE x, f32 LE y, u32 LE name_len, name bytes

Coordinates are source-composite pixels; `floor` is the app's floor index
(0 = Floor 3, 1 = Floor 2, 2 = Floor 1). Colour is ignored; only alpha matters.
"""

from collections import deque
from pathlib import Path
import struct

from kra_layers import SOURCE, layer_names, read_layer_crop

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "native" / "assets" / "items.bin"
PREFIX = "item_"

# Canonical floor frames in source-composite pixels (see artifacts/care-center/README.md).
FRAMES = {
    3: (1600, 0, 1600 + 4750, 0 + 1536),
    2: (1600, 1500, 1600 + 4750, 1500 + 2240),
    1: (1600, 3420, 1600 + 4750, 3420 + 2730),
}
UNION = (
    min(f[0] for f in FRAMES.values()),
    min(f[1] for f in FRAMES.values()),
    max(f[2] for f in FRAMES.values()),
    max(f[3] for f in FRAMES.values()),
)
# Map indices used by the app: 0 = Floor 3, 1 = Floor 2, 2 = Floor 1.
FLOOR_INDEX = {3: 0, 2: 1, 1: 2}
ALPHA_THRESHOLD = 30


def blobs(image) -> list[tuple[float, float, int]]:
    """8-connected alpha blobs: (centroid_x, centroid_y, pixel_count), absolute."""
    alpha = image.getchannel("A")
    box = alpha.getbbox()
    if box is None:
        return []
    region = alpha.crop(box)
    w, h = region.size
    px = region.load()
    seen = [bytearray(w) for _ in range(h)]
    found: list[tuple[float, float, int]] = []
    for y0 in range(h):
        for x0 in range(w):
            if px[x0, y0] <= ALPHA_THRESHOLD or seen[y0][x0]:
                continue
            seen[y0][x0] = 1
            queue = deque([(x0, y0)])
            count = 0
            sx = sy = 0
            while queue:
                x, y = queue.popleft()
                count += 1
                sx += x
                sy += y
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx]:
                            if px[nx, ny] > ALPHA_THRESHOLD:
                                seen[ny][nx] = 1
                                queue.append((nx, ny))
            found.append((box[0] + sx / count, box[1] + sy / count, count))
    return found


def floor_of(sx: float, sy: float) -> int | None:
    """Floor whose frame contains the point with the most margin."""
    best: tuple[float, int] | None = None
    for floor, (x0, y0, x1, y1) in FRAMES.items():
        if x0 <= sx <= x1 and y0 <= sy <= y1:
            margin = min(sx - x0, x1 - sx, sy - y0, y1 - sy)
            if best is None or margin > best[0]:
                best = (margin, floor)
    return best[1] if best else None


def main() -> None:
    print(f"source {SOURCE.relative_to(ROOT)}")
    layers = sorted(n for n in layer_names() if n.startswith(PREFIX))
    records: list[tuple[int, str, float, float]] = []
    for name in layers:
        label = name[len(PREFIX) :].strip()
        if not label:
            print(f"{name}: no name after {PREFIX!r} — skipped")
            continue
        marks = blobs(read_layer_crop(name, UNION))
        if len(marks) != 1:
            print(f"{name}: expected 1 circle, found {len(marks)} — skipped")
            continue
        cx, cy, _ = marks[0]
        sx, sy = UNION[0] + cx, UNION[1] + cy
        floor = floor_of(sx, sy)
        if floor is None:
            print(f"{name}: circle is outside every floor frame — skipped")
            continue
        records.append((FLOOR_INDEX[floor], label, sx, sy))
        print(f"{name}: {label!r} on F{floor} ({sx:.0f},{sy:.0f})")

    records.sort(key=lambda r: (r[0], r[1]))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    body = struct.pack("<I", len(records))
    for floor, label, sx, sy in records:
        encoded = label.encode("utf-8")
        body += struct.pack("<IffI", floor, sx, sy, len(encoded)) + encoded
    OUTPUT.write_bytes(body)
    print(f"Wrote {OUTPUT.relative_to(ROOT)} ({len(records)} items)")


if __name__ == "__main__":
    main()
