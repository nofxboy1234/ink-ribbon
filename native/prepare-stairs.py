#!/usr/bin/env python3
"""Bake the stair endpoints from the `stairs_*` layers of the Krita source.

Each `stairs_*` layer holds two X marks, one on each of the two floors the stair
connects. This decodes the layer, finds the two X blobs, assigns each to the
floor whose art frame contains it (deepest containment, so a mark sitting in the
overlapping F1/F2 band resolves to the floor it is most inside), and writes
`native/assets/stairs.bin`:

    header: u32 LE count
    record: u32 LE a_floor, u32 LE b_floor,
            f32 LE ax, f32 LE ay, f32 LE bx, f32 LE by

Coordinates are source-composite pixels. The app treats each connection as
bidirectional and triggers within a fixed radius (see map.rs).
"""

from collections import deque
from pathlib import Path
import struct

from kra_layers import SOURCE, layer_names, read_layer_crop

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "native" / "assets" / "stairs.bin"

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
    layers = sorted(n for n in layer_names() if n.startswith("stairs"))
    records: list[tuple[int, int, float, float, float, float]] = []
    for name in layers:
        marks = blobs(read_layer_crop(name, UNION))
        places = []
        for cx, cy, count in marks:
            # Blob centroid is relative to the union crop; back to source pixels.
            sx, sy = UNION[0] + cx, UNION[1] + cy
            places.append((floor_of(sx, sy), sx, sy, count))
        if len(places) != 2:
            print(f"{name}: expected 2 X marks, found {len(places)} — skipped")
            continue
        (fa, ax, ay, _), (fb, bx, by, _) = places
        if fa is None or fb is None:
            print(f"{name}: an X is outside every floor frame — skipped")
            continue
        if fa == fb:
            print(f"{name}: both X marks resolved to floor {fa} — skipped")
            continue
        # Store app floor indices, not floor numbers.
        records.append((FLOOR_INDEX[fa], FLOOR_INDEX[fb], ax, ay, bx, by))
        print(
            f"{name}: F{fa} ({ax:.0f},{ay:.0f}) <-> F{fb} ({bx:.0f},{by:.0f})"
        )

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    body = struct.pack("<I", len(records))
    for fa, fb, ax, ay, bx, by in records:
        body += struct.pack("<IIffff", fa, fb, ax, ay, bx, by)
    OUTPUT.write_bytes(body)
    print(f"Wrote {OUTPUT.relative_to(ROOT)} ({len(records)} connections)")


if __name__ == "__main__":
    main()
