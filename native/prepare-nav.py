#!/usr/bin/env python3
"""Build the Floor 1 navigation grid from the traced wall art.

The wall trace (`care-center-full-walls.png`) encloses the walkable floor area.
We rasterise it at the navigation resolution, grow the walls by a clearance so
routes keep away from them, flood-fill the exterior from the image border, and
treat everything left inside as walkable. A* then runs on this grid in Sokol.

Output: `native/assets/floor-1-nav.bin`
    header: u32 LE cell_px, u32 LE width, u32 LE height
    body:   width*height bits, row-major, LSB first per byte (1 = walkable)

Also writes a preview PNG and a reachability report (Guard Office -> key items).
"""

from collections import deque
import struct
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "artifacts" / "care-center" / "originals" / "care-center-full-walls.png"
OUTPUT = ROOT / "native" / "assets" / "floor-1-nav.bin"
PREVIEW = ROOT / "artifacts" / "care-center" / "nav-preview.png"

# Canonical Floor 1 frame and navigation resolution.
CROP = (1600, 3420, 1600 + 4750, 3420 + 2730)
CROP_W, CROP_H = 4750, 2730
CELL_PX = 8
W = round(CROP_W / CELL_PX)
H = round(CROP_H / CELL_PX)
WALL_THRESHOLD = 30
CLEARANCE_CELLS = 3

PLAYER = (3840.0, 5008.0)  # Guard Office
KEY_ITEMS = [
    ("Pantry Key", 3432.0, 3899.0),
    ("ID Wristband (Level 2)", 4751.0, 4416.0),
    ("ID Wristband (Level 3)", 6134.0, 4397.0),
    ("East Wing Keycard", 3309.0, 4590.0),
    ("Star Quartz", 4658.0, 5138.0),
    ("West Wing Keycard", 3530.0, 5162.0),
]


def source_to_cell(sx: float, sy: float) -> tuple[int, int]:
    return (
        int((sx - CROP[0]) / CROP_W * W),
        int((sy - CROP[1]) / CROP_H * H),
    )


def nearest_walkable(walk: list[bytearray], cx: int, cy: int):
    if 0 <= cx < W and 0 <= cy < H and walk[cy][cx]:
        return (cx, cy)
    for r in range(1, 80):
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                if max(abs(dx), abs(dy)) != r:
                    continue
                x, y = cx + dx, cy + dy
                if 0 <= x < W and 0 <= y < H and walk[y][x]:
                    return (x, y)
    return None


def bfs(walk: list[bytearray], start: tuple[int, int]):
    dist = {start: 0}
    came = {}
    dq = deque([start])
    while dq:
        x, y = dq.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and walk[ny][nx] and (nx, ny) not in dist:
                dist[(nx, ny)] = dist[(x, y)] + 1
                came[(nx, ny)] = (x, y)
                dq.append((nx, ny))
    return dist, came


def main() -> None:
    image = Image.open(SOURCE).convert("L").crop(CROP).resize((W, H), Image.Resampling.LANCZOS)
    wall_mask = image.point(lambda v: 255 if v > WALL_THRESHOLD else 0)
    if CLEARANCE_CELLS > 0:
        wall_mask = wall_mask.filter(ImageFilter.MaxFilter(CLEARANCE_CELLS * 2 + 1))
    wall = [[1 if wall_mask.getpixel((x, y)) else 0 for x in range(W)] for y in range(H)]
    free = [[0 if wall[y][x] else 1 for x in range(W)] for y in range(H)]

    # Flood-fill the exterior from the border.
    exterior = [[0] * W for _ in range(H)]
    dq = deque()
    for x in range(W):
        for y in (0, H - 1):
            if free[y][x]:
                exterior[y][x] = 1
                dq.append((x, y))
    for y in range(H):
        for x in (0, W - 1):
            if free[y][x]:
                exterior[y][x] = 1
                dq.append((x, y))
    while dq:
        x, y = dq.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and free[ny][nx] and not exterior[ny][nx]:
                exterior[ny][nx] = 1
                dq.append((nx, ny))

    walk = [[1 if free[y][x] and not exterior[y][x] else 0 for x in range(W)] for y in range(H)]
    total = sum(sum(row) for row in walk)

    # Pack: header + 1 bit per cell, LSB first.
    bits = bytearray((W * H + 7) // 8)
    for y in range(H):
        for x in range(W):
            if walk[y][x]:
                i = y * W + x
                bits[i >> 3] |= 1 << (i & 7)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(struct.pack("<III", CELL_PX, W, H) + bytes(bits))

    # Reachability report.
    start = nearest_walkable(walk, *source_to_cell(*PLAYER))
    print(f"nav grid {W}x{H} cell={CELL_PX}px clearance={CLEARANCE_CELLS} walkable={total}")
    print(f"player snap {start} from {source_to_cell(*PLAYER)}")
    if start is None:
        print("ERROR: player has no walkable cell")
    else:
        dist, came = bfs(walk, start)
        for name, sx, sy in KEY_ITEMS:
            target = nearest_walkable(walk, *source_to_cell(sx, sy))
            d = dist.get(target) if target else None
            print(f"  {name:24} cell={source_to_cell(sx, sy)} snap={target} reachable={d is not None} steps={d}")

    # Preview: walls grey, walkable cyan, exterior black, player/dots/path.
    preview = Image.new("RGB", (W, H), (12, 12, 16))
    px = preview.load()
    for y in range(H):
        for x in range(W):
            if wall[y][x]:
                px[x, y] = (241, 250, 140)
            elif walk[y][x]:
                px[x, y] = (30, 60, 70)
    if start:
        dist, came = bfs(walk, start)
        demo = nearest_walkable(walk, *source_to_cell(*KEY_ITEMS[1][1:]))
        if demo and demo in came:
            c = demo
            while c != start:
                px[c[0], c[1]] = (80, 250, 123)
                c = came[c]
            px[start[0], start[1]] = (80, 250, 123)
        px[start[0], start[1]] = (80, 250, 123)
    for name, sx, sy in KEY_ITEMS:
        cx, cy = source_to_cell(sx, sy)
        cell = nearest_walkable(walk, cx, cy)
        if cell:
            px[cell[0], cell[1]] = (189, 147, 249)
    preview.resize((W * 2, H * 2), Image.Resampling.NEAREST).save(PREVIEW)
    print(f"wrote {OUTPUT.relative_to(ROOT)} and {PREVIEW.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
