#!/usr/bin/env python3
"""Build the navigation grids for every floor from the Krita source.

Reads the wall/door/obstacle layers straight out of the Krita document (see
`native/kra_layers.py`). A floor that has not been traced yet gets an empty grid
so the app always has an asset to embed.

Impassable: walls, obstacles and locked doors, grown by a clearance so routes
keep away from them.
Passable:   unlocked and unknown doors, carved through after the clearance.

The exterior is flood-filled *before* the doors are carved, so a door on the
building boundary cannot leak the outside into the walkable area.

Output per floor: `native/assets/floor-N-nav.bin`, `floor-N-nav-open.bin`,
`floor-N-solid.bin`.

    nav / nav-open header: u32 LE cell_px, u32 LE width, u32 LE height
    body:                  width*height bits, row-major, LSB first per byte
                           (1 = walkable)
    solid header:          same, 1 = wall/obstacle/locked door

Also writes a preview PNG and (for Floor 1) a reachability report.
"""

from collections import deque
import struct
from pathlib import Path

from PIL import Image, ImageFilter

from kra_layers import SOURCE, read_floor

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "native" / "assets"
PREVIEW_DIR = ROOT / "artifacts" / "care-center"

# Canonical floor frames in source-composite pixels (see artifacts/care-center/README.md).
FLOORS = {
    1: (1600, 3420, 1600 + 4750, 3420 + 2730),
    2: (1600, 1500, 1600 + 4750, 1500 + 2240),
    3: (1600, 0, 1600 + 4750, 0 + 1536),
}
CELL_PX = 8
# High-resolution solid mask for player collision (1 = wall/obstacle/locked door).
# The nav grid has to be coarse (it pads for routing); collision wants the real
# geometry, so it is baked separately at 2 source px per cell.
SOLID_CELL_PX = 2
ALPHA_THRESHOLD = 30
CLEARANCE_CELLS = 2
DOOR_DILATION_CELLS = 1

CATEGORIES = ("walls", "obstacles", "locked_doors", "unlocked_doors", "unknown_doors")

# Floor 1 reachability anchors, in source-composite pixels. Other floors have
# no traced items yet, so they only get the grids and a preview.
PLAYER = {1: (3840.0, 5008.0)}  # Guard Office
KEY_ITEMS = {
    1: [
        ("Pantry Key", 3432.0, 3899.0),
        ("ID Wristband (Level 2)", 4751.0, 4416.0),
        ("ID Wristband (Level 3)", 6134.0, 4397.0),
        ("East Wing Keycard", 3309.0, 4590.0),
        ("Star Quartz", 4658.0, 5138.0),
        ("West Wing Keycard", 3530.0, 5162.0),
    ]
}


def mask(floor: int, category: str, crop, w: int, h: int) -> list[bytearray]:
    image = (
        read_floor(floor, category, crop)
        .convert("RGBA")
        .resize((w, h), Image.Resampling.LANCZOS)
    )
    alpha = image.getchannel("A").point(lambda v: 255 if v > ALPHA_THRESHOLD else 0)
    return [bytearray(1 if alpha.getpixel((x, y)) else 0 for x in range(w)) for y in range(h)]


def dilate(source: list[bytearray], radius: int, w: int, h: int) -> list[bytearray]:
    if radius <= 0:
        return source
    image = Image.new("L", (w, h))
    image.putdata([255 if source[y][x] else 0 for y in range(h) for x in range(w)])
    image = image.filter(ImageFilter.MaxFilter(radius * 2 + 1))
    return [bytearray(1 if image.getpixel((x, y)) else 0 for x in range(w)) for y in range(h)]


def flood_exterior(free: list[bytearray], w: int, h: int) -> list[bytearray]:
    exterior = [bytearray(w) for _ in range(h)]
    dq = deque()
    for x in range(w):
        for y in (0, h - 1):
            if free[y][x]:
                exterior[y][x] = 1
                dq.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if free[y][x]:
                exterior[y][x] = 1
                dq.append((x, y))
    while dq:
        x, y = dq.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and free[ny][nx] and not exterior[ny][nx]:
                exterior[ny][nx] = 1
                dq.append((nx, ny))
    return exterior


def source_to_cell(crop, sx: float, sy: float, w: int, h: int) -> tuple[int, int]:
    cw, ch = crop[2] - crop[0], crop[3] - crop[1]
    return (
        int((sx - crop[0]) / cw * w),
        int((sy - crop[1]) / ch * h),
    )


def nearest_walkable(walk: list[bytearray], cx: int, cy: int, w: int, h: int):
    if 0 <= cx < w and 0 <= cy < h and walk[cy][cx]:
        return (cx, cy)
    for r in range(1, 80):
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                if max(abs(dx), abs(dy)) != r:
                    continue
                x, y = cx + dx, cy + dy
                if 0 <= x < w and 0 <= y < h and walk[y][x]:
                    return (x, y)
    return None


def bfs(walk: list[bytearray], start: tuple[int, int], w: int, h: int):
    dist = {start: 0}
    came = {}
    dq = deque([start])
    while dq:
        x, y = dq.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and walk[ny][nx] and (nx, ny) not in dist:
                dist[(nx, ny)] = dist[(x, y)] + 1
                came[(nx, ny)] = (x, y)
                dq.append((nx, ny))
    return dist, came


def build_floor(floor: int, crop) -> None:
    cw, ch = crop[2] - crop[0], crop[3] - crop[1]
    w, h = round(cw / CELL_PX), round(ch / CELL_PX)
    sw, sh = round(cw / SOLID_CELL_PX), round(ch / SOLID_CELL_PX)

    walls = mask(floor, "walls", crop, w, h)
    obstacles = mask(floor, "obstacles", crop, w, h)
    locked = mask(floor, "locked_doors", crop, w, h)
    unlocked = mask(floor, "unlocked_doors", crop, w, h)
    unknown = mask(floor, "unknown_doors", crop, w, h)
    doors = dilate(
        [bytearray(1 if unlocked[y][x] or unknown[y][x] else 0 for x in range(w)) for y in range(h)],
        DOOR_DILATION_CELLS,
        w,
        h,
    )
    # Only open a door where there is actually floor: a door bar drawn across the
    # wall ends must not punch a hole through the wall itself.
    doors = [
        bytearray(
            1 if doors[y][x] and not (walls[y][x] or obstacles[y][x] or locked[y][x]) else 0
            for x in range(w)
        )
        for y in range(h)
    ]

    def build(include_locked: bool) -> list[bytearray]:
        base = [
            bytearray(
                1
                if walls[y][x] or obstacles[y][x] or (locked[y][x] and include_locked)
                else 0
                for x in range(w)
            )
            for y in range(h)
        ]
        impassable = dilate(base, CLEARANCE_CELLS, w, h)
        free = [bytearray(0 if impassable[y][x] else 1 for x in range(w)) for y in range(h)]
        exterior = flood_exterior(free, w, h)
        return [
            bytearray(
                1 if ((free[y][x] and not exterior[y][x]) or doors[y][x]) else 0
                for x in range(w)
            )
            for y in range(h)
        ]

    walk = build(include_locked=True)
    walk_unlocked = build(include_locked=False)

    bits = bytearray((w * h + 7) // 8)
    for y in range(h):
        for x in range(w):
            if walk[y][x]:
                i = y * w + x
                bits[i >> 3] |= 1 << (i & 7)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / f"floor-{floor}-nav.bin").write_bytes(struct.pack("<III", CELL_PX, w, h) + bytes(bits))

    # Optimistic grid: same as above but locked doors are passable, so a route
    # can be traced up to (and past) a locked-door blocker for display.
    open_bits = bytearray((w * h + 7) // 8)
    for y in range(h):
        for x in range(w):
            if walk_unlocked[y][x]:
                i = y * w + x
                open_bits[i >> 3] |= 1 << (i & 7)
    (OUTPUT / f"floor-{floor}-nav-open.bin").write_bytes(
        struct.pack("<III", CELL_PX, w, h) + bytes(open_bits)
    )

    # Solid collision mask at 2px: walls + obstacles + locked doors, no padding.
    s_walls = mask(floor, "walls", crop, sw, sh)
    s_obstacles = mask(floor, "obstacles", crop, sw, sh)
    s_locked = mask(floor, "locked_doors", crop, sw, sh)
    solid_bits = bytearray((sw * sh + 7) // 8)
    solid_count = 0
    for y in range(sh):
        for x in range(sw):
            if s_walls[y][x] or s_obstacles[y][x] or s_locked[y][x]:
                i = y * sw + x
                solid_bits[i >> 3] |= 1 << (i & 7)
                solid_count += 1
    (OUTPUT / f"floor-{floor}-solid.bin").write_bytes(
        struct.pack("<III", SOLID_CELL_PX, sw, sh) + bytes(solid_bits)
    )
    print(f"floor {floor}: nav {w}x{h} cell={CELL_PX}px walkable={sum(sum(r) for r in walk)}")
    print(f"floor {floor}: solid grid {sw}x{sh} cell={SOLID_CELL_PX}px blocked={solid_count}")

    report(floor, crop, w, h, walk, walk_unlocked, walls)
    preview(floor, w, h, walk, walls, obstacles, locked, unknown, unlocked)


def report(floor, crop, w, h, walk, walk_unlocked, walls) -> None:
    if floor not in PLAYER:
        return
    start = nearest_walkable(walk, *source_to_cell(crop, *PLAYER[floor], w, h), w, h)
    if start is None:
        print(f"floor {floor}: ERROR player has no walkable cell")
        return
    dist, came = bfs(walk, start, w, h)
    dist_unlocked, _ = (
        bfs(walk_unlocked, start, w, h) if walk_unlocked[start[1]][start[0]] else ({}, {})
    )
    print(f"floor {floor}: player snap {start}")
    for name, sx, sy in KEY_ITEMS.get(floor, []):
        target = nearest_walkable(walk, *source_to_cell(crop, sx, sy, w, h), w, h)
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
            target_unlocked = nearest_walkable(
                walk_unlocked, *source_to_cell(crop, sx, sy, w, h), w, h
            )
            gated = target_unlocked is not None and target_unlocked in dist_unlocked
            note = "LOCKED-DOOR GATED" if gated else "DISCONNECTED"
        print(f"  {name:24} cell={source_to_cell(crop, sx, sy, w, h)} snap={target} {note}")


def preview(floor, w, h, walk, walls, obstacles, locked, unknown, unlocked) -> None:
    image = Image.new("RGB", (w, h), (12, 12, 16))
    px = image.load()
    for y in range(h):
        for x in range(w):
            if walk[y][x]:
                px[x, y] = (30, 60, 70)
    for y in range(h):
        for x in range(w):
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
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    path = PREVIEW_DIR / f"floor-{floor}-nav-preview.png"
    image.resize((w * 2, h * 2), Image.Resampling.NEAREST).save(path)
    print(f"floor {floor}: wrote {path.relative_to(ROOT)}")


def main() -> None:
    print(f"source {SOURCE.relative_to(ROOT)}")
    # Always emit every floor: the app embeds all of them, and an untraced floor
    # is written as an empty grid so the build stays valid.
    for floor, crop in sorted(FLOORS.items()):
        build_floor(floor, crop)


if __name__ == "__main__":
    main()
