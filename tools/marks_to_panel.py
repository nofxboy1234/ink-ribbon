#!/usr/bin/env python3
"""Turn picked corner marks into a world-space quad.

Reads the JSON the viewer copies out of mark mode and writes ``data/panels.json``
for ``tools/build_real.py``. Each corner is triangulated from the picked views
by least-squares ray intersection, so the corner does not have to lie on any
assumed plane.
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "panels.json"
FOV = 0.62


def ray(camera: dict, canvas, point) -> tuple[np.ndarray, np.ndarray]:
    eye = np.asarray(camera["eye"], dtype=float)
    yaw = float(camera["yaw"])
    pitch = float(camera["pitch"])
    width, height = canvas
    fwd = np.array(
        [
            math.sin(yaw) * math.cos(pitch),
            math.sin(pitch),
            math.cos(yaw) * math.cos(pitch),
        ]
    )
    right = np.cross(fwd, [0.0, 1.0, 0.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    tan_half = math.tan(FOV / 2.0)
    aspect = width / height
    nx = (float(point[0]) / width) * 2.0 - 1.0
    ny = 1.0 - (float(point[1]) / height) * 2.0
    direction = fwd + right * (nx * tan_half * aspect) + up * (ny * tan_half)
    return eye, direction / np.linalg.norm(direction)


def triangulate(rays):
    """Closest point to a set of rays, in the least-squares sense."""
    a = np.zeros((3, 3))
    b = np.zeros(3)
    for eye, direction in rays:
        projector = np.eye(3) - np.outer(direction, direction)
        a += projector
        b += projector @ eye
    point, *_ = np.linalg.lstsq(a, b, rcond=None)
    residuals = [
        float(np.linalg.norm((np.eye(3) - np.outer(d, d)) @ (point - e)))
        for e, d in rays
    ]
    return point, max(residuals)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("marks", type=pathlib.Path)
    parser.add_argument("--out", type=pathlib.Path, default=OUT)
    args = parser.parse_args()

    payload = json.loads(args.marks.read_text())
    canvas = payload["canvas"]
    views = payload["views"]
    if len(views) < 2:
        sys.exit("need at least two camera positions")

    counts = {len(view["points"]) for view in views}
    if len(counts) != 1:
        sys.exit(f"each view needs the same number of corners, got {sorted(counts)}")
    corners = counts.pop()
    if corners < 3:
        sys.exit("need at least three corners")

    world = []
    for index in range(corners):
        rays = [ray(view, canvas, view["points"][index]) for view in views]
        point, residual = triangulate(rays)
        print(
            f"corner {index + 1}: "
            f"({point[0]:7.2f}, {point[1]:6.2f}, {point[2]:7.2f}) "
            f"residual {residual:.3f} m"
        )
        if residual > 0.25:
            print(f"  warning: corner {index + 1} rays miss by {residual:.2f} m")
        world.append([round(float(v), 3) for v in point])

    centre = np.mean(np.asarray(world), axis=0)
    normal = np.cross(
        np.subtract(world[1], world[0]), np.subtract(world[2], world[0])
    )
    length = np.linalg.norm(normal)
    if length > 1e-6:
        normal = normal / length
        offsets = [float(np.dot(np.subtract(p, centre), normal)) for p in world]
        spread = max(offsets) - min(offsets)
        print(f"planarity: corners deviate {spread:.3f} m along the normal")

    existing = []
    if args.out.exists():
        existing = json.loads(args.out.read_text())
    duplicate = any(
        np.allclose(np.asarray(panel["points"]), np.asarray(world), atol=0.05)
        for panel in existing
    )
    if duplicate:
        print("an identical panel is already recorded, nothing added")
    else:
        existing.append({"points": world})
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(existing, indent=1) + "\n")
    where = args.out.relative_to(ROOT) if args.out.is_relative_to(ROOT) else args.out
    print(f"wrote {where} with {len(existing)} panel(s)")


if __name__ == "__main__":
    main()
