#!/usr/bin/env python3
"""Build the Floor 1 navigation grid from the traced wall/door/obstacle art.

Impassable: walls, obstacles and locked doors, grown by a clearance so routes
keep away from them.
Passable:   unlocked and unknown doors, carved through after the clearance.

The exterior is flood-filled *before* the doors are carved, so a door on the
building boundary cannot leak the outside into the walkable area.

Output: `native/assets/floor-1-nav.bin`
    header: u32 LE cell_px, u32 LE width, u32 LE height
    body:   width*height bits, row-major, LSB first per byte (1 = walkable)

Also writes a preview PNG and a reachability report (Guard Office -> key items),
flagging items that are only blocked by locked doors.
"""

from collections import deque
import struct
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
ORIGINALS = ROOT / "artifacts" / "care-center" / "originals"
OUTPUT = ROOT / "native" / "assets" / "floor-1-nav.bin"
OUTPUT_OPEN = ROOT / "native" / "assets" / "floor-1-nav-open.bin"
OUTPUT_SOLID = ROOT / "native" / "assets" / "floor-1-solid.bin"
PREVIEW = ROOT / "artifacts" / "care-center" / "nav-preview.png"

# Canonical Floor 1 frame and navigation resolution.
CROP = (1600, 3420, 1600 + 4750, 3420 + 2730)
CROP_W, CROP_H = 4750, 2730
CELL_PX = 8
W = round(CROP_W / CELL_PX)
H = round(CROP_H / CELL_PX)

# High-resolution solid mask for player collision (1 = wall/obstacle/locked door).
# The nav grid has to be coarse (it pads for routing); collision wants the real
# geometry, so it is baked separately at 2 source px per cell.
SOLID_CELL_PX = 2
SW = round(CROP_W / SOLID_CELL_PX)
SH = round(CROP_H / SOLID_CELL_PX)
ALPHA_THRESHOLD = 30
CLEARANCE_CELLS = 2
DOOR_DILATION_CELLS = 1

WALLS = "care-center-full-walls.png"
OBSTACLES = "care-center-full-obstacles.png"
LOCKED = "care-center-full-locked_doors.png"
UNLOCKED = "care-center-full-unlocked_doors.png"
UNKNOWN = "care-center-full-unknown_doors.png"

PLAYER = (3840.0, 5008.0)  # Guard Office
KEY_ITEMS = [
    ("Pantry Key", 3432.0, 3899.0),
    ("ID Wristband (Level 2)", 4751.0, 4416.0),
    ("ID Wristband (Level 3)", 6134.0, 4397.0),
    ("East Wing Keycard", 3309.0, 4590.0),
    ("Star Quartz", 4658.0, 5138.0),
    ("West Wing Keycard", 3530.0, 5162.0),
]


def mask(name: str, w: int = W, h: int = H) -> list[bytearray]:
    image = (
        Image.open(ORIGINALS / name)
        .convert("RGBA")
        .crop(CROP)
        .resize((w, h), Image.Resampling.LANCZOS)
    )
    alpha = image.getchannel("A").point(lambda v: 255 if v > ALPHA_THRESHOLD else 0)
    return [bytearray(1 if alpha.getpixel((x, y)) else 0 for x in range(w)) for y in range(h)]


def dilate(source: list[bytearray], radius: int) -> list[bytearray]:
    if radius <= 0:
        return source
    image = Image.new("L", (W, H))
    image.putdata([255 if source[y][x] else 0 for y in range(H) for x in range(W)])
    image = image.filter(ImageFilter.MaxFilter(radius * 2 + 1))
    return [bytearray(1 if image.getpixel((x, y)) else 0 for x in range(W)) for y in range(H)]


def flood_exterior(free: list[bytearray]) -> list[bytearray]:
    exterior = [bytearray(W) for _ in range(H)]
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
    return exterior


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
    walls = mask(WALLS)
    obstacles = mask(OBSTACLES)
    locked = mask(LOCKED)
    unlocked = mask(UNLOCKED)
    unknown = mask(UNKNOWN)
    doors = dilate(
        [bytearray(1 if unlocked[y][x] or unknown[y][x] else 0 for x in range(W)) for y in range(H)],
        DOOR_DILATION_CELLS,
    )
    # Only open a door where there is actually floor: a door bar drawn across the
    # wall ends must not punch a hole through the wall itself.
    doors = [
        bytearray(
            1 if doors[y][x] and not (walls[y][x] or obstacles[y][x] or locked[y][x]) else 0
            for x in range(W)
        )
        for y in range(H)
    ]

    def build(include_locked: bool) -> list[bytearray]:
        base = [
            bytearray(
                1
                if walls[y][x] or obstacles[y][x] or (locked[y][x] and include_locked)
                else 0
                for x in range(W)
            )
            for y in range(H)
        ]
        impassable = dilate(base, CLEARANCE_CELLS)
        free = [bytearray(0 if impassable[y][x] else 1 for x in range(W)) for y in range(H)]
        exterior = flood_exterior(free)
        return [
            bytearray(
                1 if ((free[y][x] and not exterior[y][x]) or doors[y][x]) else 0
                for x in range(W)
            )
            for y in range(H)
        ]

    walk = build(include_locked=True)
    walk_unlocked = build(include_locked=False)

    bits = bytearray((W * H + 7) // 8)
    for y in range(H):
        for x in range(W):
            if walk[y][x]:
                i = y * W + x
                bits[i >> 3] |= 1 << (i & 7)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(struct.pack("<III", CELL_PX, W, H) + bytes(bits))

    # Optimistic grid: same as above but locked doors are passable, so a route
    # can be traced up to (and past) a locked-door blocker for display.
    open_bits = bytearray((W * H + 7) // 8)
    for y in range(H):
        for x in range(W):
            if walk_unlocked[y][x]:
                i = y * W + x
                open_bits[i >> 3] |= 1 << (i & 7)
    OUTPUT_OPEN.write_bytes(struct.pack("<III", CELL_PX, W, H) + bytes(open_bits))

    # Solid collision mask at 2px: walls + obstacles + locked doors, no padding.
    s_walls = mask(WALLS, SW, SH)
    s_obstacles = mask(OBSTACLES, SW, SH)
    s_locked = mask(LOCKED, SW, SH)
    solid_bits = bytearray((SW * SH + 7) // 8)
    solid_count = 0
    for y in range(SH):
        for x in range(SW):
            if s_walls[y][x] or s_obstacles[y][x] or s_locked[y][x]:
                i = y * SW + x
                solid_bits[i >> 3] |= 1 << (i & 7)
                solid_count += 1
    OUTPUT_SOLID.write_bytes(struct.pack("<III", SOLID_CELL_PX, SW, SH) + bytes(solid_bits))
    print(f"solid grid {SW}x{SH} cell={SOLID_CELL_PX}px blocked={solid_count}")

    start = nearest_walkable(walk, *source_to_cell(*PLAYER))
    print(
        f"nav grid {W}x{H} cell={CELL_PX}px clearance={CLEARANCE_CELLS} "
        f"door_dilation={DOOR_DILATION_CELLS} walkable={sum(sum(r) for r in walk)}"
    )
    if start is None:
        print("ERROR: player has no walkable cell")
        return
    dist, came = bfs(walk, start)
    dist_unlocked, _ = bfs(walk_unlocked, start) if walk_unlocked[start[1]][start[0]] else ({}, {})
    print(f"player snap {start} from {source_to_cell(*PLAYER)}")
    for name, sx, sy in KEY_ITEMS:
        target = nearest_walkable(walk, *source_to_cell(sx, sy))
        reachable = target is not None and target in dist
        if reachable:
            clipped = 0
            node = target
            while node != start:
                if walls[node[1]][node[0]]:
                    clipped += 1
                node = came[node]
            note = f"reachable steps={dist[target]} through_wall={clipped}"
        else:
            target_unlocked = nearest_walkable(walk_unlocked, *source_to_cell(sx, sy))
            gated = target_unlocked is not None and target_unlocked in dist_unlocked
            note = "LOCKED-DOOR GATED" if gated else "DISCONNECTED"
        print(f"  {name:24} cell={source_to_cell(sx, sy)} snap={target} {note}")

    # Preview (colour-coded by category).
    preview = Image.new("RGB", (W, H), (12, 12, 16))
    px = preview.load()
    for y in range(H):
        for x in range(W):
            if walk[y][x]:
                px[x, y] = (30, 60, 70)
    for y in range(H):
        for x in range(W):
            if walls[y][x]:
                px[x, y] = (241, 250, 140)
            elif obstacles[y][x]:
                px[x, y] = (255, 121, 198)
            elif locked[y][x]:
                px[x, y] = (255, 85, 85)
            elif unknown[y][x]:
                px[x, y] = (140, 150, 190)
            elif unlocked[y][x]:
                px[x, y] = (139, 233, 253)
    demo = nearest_walkable(walk, *source_to_cell(*KEY_ITEMS[1][1:]))
    if demo is not None and demo in came:
        c = demo
        while c != start:
            px[c[0], c[1]] = (80, 250, 123)
            c = came[c]
    px[start[0], start[1]] = (80, 250, 123)
    for name, sx, sy in KEY_ITEMS:
        cell = nearest_walkable(walk, *source_to_cell(sx, sy))
        if cell:
            px[cell[0], cell[1]] = (189, 147, 249)
    preview.resize((W * 2, H * 2), Image.Resampling.NEAREST).save(PREVIEW)
    print(
        f"wrote {OUTPUT.relative_to(ROOT)}, {OUTPUT_OPEN.relative_to(ROOT)}, "
        f"{OUTPUT_SOLID.relative_to(ROOT)} and {PREVIEW.relative_to(ROOT)}"
    )


if __name__ == "__main__":
    main()
