#!/usr/bin/env python3
"""Draw the MapGenie item mapping over the sokol plans and check door marks.

Run:

    uv run --with opencv-python-headless --with numpy \
        python tools/mapgenie_overlay.py --fetch-mosaic /tmp/mapgenie/mosaic_z14.png

Images land in build/mapgenie-overlay-<floor>.png. The sokol side needs no
network. --fetch-mosaic downloads the z14 tiles at x 8134..8148 and y
8157..8179 and stitches them at 256 px per tile, then draws the raw MapGenie
pixels as well.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import urllib.request

import cv2
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
ITEMS = ROOT / "public" / "rpd" / "items_mapgenie.json"
PLAN = ROOT / "public" / "rpd" / "plan.json"
NAV = ROOT / "public" / "rpd" / "nav.json"
OUT = ROOT / "build"

PLAN_FILES = {"1F": "1f", "2F": "2f", "3F": "3f", "4F": "4f", "B1": "b1"}
TILE_URL = "https://tiles.mapgenie.io/games/resident-evil-2-remake/claire-a/default-v1/14/{y}/{x}.jpg"
TILE_X0, TILE_X1 = 8134, 8148
TILE_Y0, TILE_Y1 = 8157, 8179
COLOURS = {
    "ok": (60, 200, 60),
    "nav_gap": (0, 165, 255),
    "outside": (0, 0, 255),
}


def fetch_mosaic(path: pathlib.Path) -> None:
    """Download the z14 tile range the affines were fitted on and stitch it."""
    width = (TILE_X1 - TILE_X0 + 1) * 256
    height = (TILE_Y1 - TILE_Y0 + 1) * 256
    image = np.zeros((height, width, 3), np.uint8)
    for x in range(TILE_X0, TILE_X1 + 1):
        for y in range(TILE_Y0, TILE_Y1 + 1):
            request = urllib.request.Request(
                TILE_URL.format(x=x, y=y), headers={"User-Agent": "Mozilla/5.0"}
            )
            data = urllib.request.urlopen(request).read()
            tile = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
            if tile is None:
                raise SystemExit(f"cannot decode tile {x},{y}")
            image[(y - TILE_Y0) * 256:(y - TILE_Y0) * 256 + 256,
                  (x - TILE_X0) * 256:(x - TILE_X0) * 256 + 256] = tile
    cv2.imwrite(str(path), image)
    print(f"wrote {path} ({width}x{height})")


def draw_sokol(items: dict, plan: dict, nav: dict, out_dir: pathlib.Path) -> None:
    boxes = {floor["label"]: floor["index"] for floor in plan["floors"]}
    for floor, image in PLAN_FILES.items():
        img = cv2.imread(str(ROOT / "tools" / "rpd_plans" / f"{image}.png"))
        canvas = cv2.resize(img, None, fx=3, fy=3, interpolation=cv2.INTER_NEAREST)
        scale = 3
        calibration = items["floors"][floor]["calibration"]
        s, ox, oy = calibration["s"], calibration["ox"], calibration["oy"]
        for node in nav["nodes"]:
            if node["floor"] != boxes[floor]:
                continue
            px = int(round((node["x"] * s + ox) * scale))
            py = int(round((node["z"] * s + oy) * scale))
            if 0 <= px < canvas.shape[1] and 0 <= py < canvas.shape[0]:
                cv2.circle(canvas, (px, py), 2, (255, 160, 0), -1)
        for item in items["items"]:
            if item["floor"] != floor:
                continue
            px = int(round(item["plan_px"][0] * scale))
            py = int(round(item["plan_px"][1] * scale))
            if not item["inside_plan_bounds"]:
                colour = COLOURS["outside"]
            elif item["nearest_nav"] > 2.0:
                colour = COLOURS["nav_gap"]
            else:
                colour = COLOURS["ok"]
            cv2.circle(canvas, (px, py), 8, colour, 2)
            cv2.putText(canvas, str(item["id"]), (px + 9, py - 5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.36, (0, 0, 0), 1, cv2.LINE_AA)
        target = out_dir / f"mapgenie-overlay-{floor}.png"
        cv2.imwrite(str(target), canvas)
        print(f"wrote {target.relative_to(ROOT)}")


def check_doors(items: dict, out_dir: pathlib.Path) -> None:
    for floor, image in PLAN_FILES.items():
        plan = cv2.imread(str(ROOT / "tools" / "rpd_plans" / f"{image}.png"),
                          cv2.IMREAD_UNCHANGED)
        b, g, r = cv2.split(plan[:, :, :3])
        orange = (r.astype(int) > 150) & (g.astype(int) > 90) & (g.astype(int) < 200) & (b.astype(int) < 120)
        ys, xs = np.where(orange)
        if len(xs) == 0:
            print(f"{floor}: no orange door marks")
            continue
        rows = []
        for item in items["items"]:
            if item["floor"] != floor or "Door" not in item["title"]:
                continue
            px, py = item["plan_px"]
            distance = float(np.min(np.hypot(xs - px, ys - py)))
            rows.append((distance, item["id"], item["title"]))
        if not rows:
            continue
        rows.sort(reverse=True)
        distances = [row[0] for row in rows]
        print(
            f"{floor}: {len(rows)} door markers, median {np.median(distances):.2f}px "
            f"p90 {np.percentile(distances, 90):.2f}px max {max(distances):.2f}px"
        )
        for distance, marker_id, title in rows[:5]:
            if distance > 1.0:
                print(f"   {marker_id} {title} {distance:.2f}px")


def draw_mapgenie(items: dict, mosaic: pathlib.Path, out_dir: pathlib.Path) -> None:
    image = cv2.imread(str(mosaic))
    if image is None:
        raise SystemExit(f"cannot read {mosaic}")
    for floor, image_name in PLAN_FILES.items():
        x0, y0, x1, y1 = items["floors"][floor]["mapgenie_crop_z14"]
        crop = image[y0:y1, x0:x1].copy()
        for item in items["items"]:
            if item["floor"] != floor:
                continue
            px = int(round(item["mapgenie_px"][0] - x0))
            py = int(round(item["mapgenie_px"][1] - y0))
            colour = COLOURS["outside"] if not item["inside_plan_bounds"] else COLOURS["ok"]
            cv2.circle(crop, (px, py), 8, colour, 2)
            cv2.putText(crop, str(item["id"]), (px + 9, py - 5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.36, (0, 255, 255), 1, cv2.LINE_AA)
        target = out_dir / f"mapgenie-overlay-raw-{floor}.png"
        cv2.imwrite(str(target), crop)
        print(f"wrote {target.relative_to(ROOT)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--items", type=pathlib.Path, default=ITEMS)
    parser.add_argument("--mosaic", type=pathlib.Path, help="z14 tile mosaic PNG")
    parser.add_argument("--fetch-mosaic", type=pathlib.Path,
                        help="download and stitch the z14 tiles, then use them as the mosaic")
    parser.add_argument("--out", type=pathlib.Path, default=OUT)
    parser.add_argument("--no-doors", action="store_true")
    args = parser.parse_args()

    items = json.loads(args.items.read_text())
    plan = json.loads(PLAN.read_text())
    nav = json.loads(NAV.read_text())
    args.out.mkdir(parents=True, exist_ok=True)
    draw_sokol(items, plan, nav, args.out)
    if not args.no_doors:
        check_doors(items, args.out)
    mosaic = args.mosaic
    if args.fetch_mosaic:
        fetch_mosaic(args.fetch_mosaic)
        mosaic = args.fetch_mosaic
    if mosaic:
        draw_mapgenie(items, mosaic, args.out)


if __name__ == "__main__":
    main()
