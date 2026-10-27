#!/usr/bin/env python3
"""Turn extracted RE2 RT RPD terrain meshes into one wireframe scene asset.

The RE meshes store each room's static level geometry in world space. We keep
LOD 0, drop ceilings and other downward-facing surfaces (so the map reads as a
cutaway), clip background geometry, and write a compact indexed triangle mesh.
"""

from __future__ import annotations

import argparse
import array
import json
import math
import pathlib
import struct
import sys

import remesh

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "rpd"
OUT_BIN = ROOT / "public" / "rpd" / "rpd.bin"
OUT_JSON = ROOT / "public" / "rpd" / "rpd.json"

# The playable RPD floors fit in this box; the tails outside it are exterior
# backdrop geometry (distant walls, skyline pieces) that reads as noise.
CLIP_MIN = (-60.0, -8.0, -40.0)
CLIP_MAX = (55.0, 55.0, 30.0)

# Horizontal surfaces within this distance of a room's top are its ceiling or
# roof. Dropping them turns each room into an open-topped cutaway.
CEILING_CLEARANCE = 1.6

FLOOR_OF_ROOM = {
    "1": 0,
    "2": 0,
    "3": 0,
    "4": 1,
    "5": 1,
    "6": 2,
}


def room_floor(room: str) -> int:
    return FLOOR_OF_ROOM[room.split("_")[1][0]]


def triangle_normal_y(
    a: tuple[float, float, float],
    b: tuple[float, float, float],
    c: tuple[float, float, float],
) -> float:
    abx, aby, abz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    acx, acy, acz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    return abz * acx - abx * acz


def inside_clip(points) -> bool:
    return all(
        CLIP_MIN[0] <= x <= CLIP_MAX[0]
        and CLIP_MIN[1] <= y <= CLIP_MAX[1]
        and CLIP_MIN[2] <= z <= CLIP_MAX[2]
        for x, y, z in points
    )


def simplify_room(room_vertices, triangles, reduction: float):
    if reduction <= 0.0 or len(triangles) < 64:
        return room_vertices, triangles
    import numpy as np
    import fast_simplification

    used = sorted({index for tri in triangles for index in tri})
    remap = {old: new for new, old in enumerate(used)}
    points = np.asarray([room_vertices[index] for index in used], dtype=np.float32)
    faces = np.asarray(
        [[remap[a], remap[b], remap[c]] for a, b, c in triangles], dtype=np.int32
    )
    new_points, new_faces = fast_simplification.simplify(
        points, faces, target_reduction=reduction, agg=7
    )
    result = []
    for tri in new_faces.tolist():
        a, b, c = int(tri[0]), int(tri[1]), int(tri[2])
        if a == b or b == c or a == c:
            continue
        result.append((a, b, c))
    return [tuple(float(v) for v in p) for p in new_points.tolist()], result


def build(
    keep_ceilings: bool,
    dedupe: bool,
    reduction: float,
    edge_min: float,
    edge_angle: float,
    edge_long: float,
):
    files = sorted(RAW.glob("*.mesh"), key=lambda p: (room_floor(p.stem), p.stem))
    if not files:
        sys.exit(f"no meshes in {RAW}; run tools/extract_rpd.py first")

    positions = array.array("f")
    indices = array.array("I")
    edges = array.array("I")
    room_stats = []
    floors = [
        {
            "tri_start": 0,
            "tri_count": 0,
            "edge_start": 0,
            "edge_count": 0,
            "y_min": math.inf,
            "y_max": -math.inf,
        }
        for _ in range(3)
    ]
    total_tris = 0
    dropped_ceiling = 0
    dropped_clip = 0
    duplicate = 0

    for path in files:
        room = path.stem
        floor = room_floor(room)
        mesh = remesh.parse(path.read_bytes())
        lod = mesh.lods[0]

        room_vertices: list[tuple[float, float, float]] = []
        room_triangles: list[tuple[int, int, int]] = []
        for group in lod.groups:
            base = len(room_vertices)
            room_vertices.extend(remesh.positions(mesh, group))
            for tri in remesh.triangles(mesh, group):
                room_triangles.append((tri[0] + base, tri[1] + base, tri[2] + base))

        y_max = max(p[1] for p in room_vertices) if room_vertices else 0.0
        ceiling_cut = y_max - CEILING_CLEARANCE
        kept: list[tuple[int, int, int]] = []
        seen: set[tuple[int, int, int]] = set() if dedupe else None  # type: ignore[assignment]
        for tri in room_triangles:
            a, b, c = (room_vertices[tri[0]], room_vertices[tri[1]], room_vertices[tri[2]])
            ny = triangle_normal_y(a, b, c)
            if not keep_ceilings and ny < 0.0:
                dropped_ceiling += 1
                continue
            if not keep_ceilings:
                span = max(a[1], b[1], c[1]) - min(a[1], b[1], c[1])
                centroid_y = (a[1] + b[1] + c[1]) / 3.0
                if span < 0.35 and centroid_y > ceiling_cut:
                    dropped_ceiling += 1
                    continue
            if not inside_clip((a, b, c)):
                dropped_clip += 1
                continue
            key = tuple(sorted(tri))
            if seen is not None:
                if key in seen:
                    duplicate += 1
                    continue
                seen.add(key)
            kept.append(tri)

        room_vertices, kept = simplify_room(room_vertices, kept, reduction)

        if floors[floor]["tri_count"] == 0:
            floors[floor]["tri_start"] = total_tris
        if floors[floor]["edge_count"] == 0:
            floors[floor]["edge_start"] = len(edges) // 2

        used: dict[int, int] = {}
        for tri in kept:
            out = []
            for vi in tri:
                if vi not in used:
                    used[vi] = len(positions) // 3
                    positions.extend(room_vertices[vi])
                out.append(used[vi])
            indices.extend(out)
            y = room_vertices[tri[0]][1]
            f = floors[floor]
            f["y_min"] = min(f["y_min"], y)
            f["y_max"] = max(f["y_max"], y)

        edge_normals: dict[tuple[int, int], list[tuple[float, float, float]]] = {}
        for a, b, c in kept:
            pa, pb, pc = room_vertices[a], room_vertices[b], room_vertices[c]
            nx = (pb[1] - pa[1]) * (pc[2] - pa[2]) - (pb[2] - pa[2]) * (pc[1] - pa[1])
            ny = (pb[2] - pa[2]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[2] - pa[2])
            nz = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])
            length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
            normal = (nx / length, ny / length, nz / length)
            for u, v in ((a, b), (b, c), (c, a)):
                key = (u, v) if u < v else (v, u)
                edge_normals.setdefault(key, []).append(normal)

        kept_edges = 0
        cos_limit = math.cos(math.radians(edge_angle))
        for (a, b), normals in edge_normals.items():
            pa = room_vertices[a]
            pb = room_vertices[b]
            length = math.dist(pa, pb)
            if length < edge_min:
                continue
            if len(normals) == 1:
                keep = True
            else:
                keep = False
                for i in range(len(normals)):
                    for j in range(i + 1, len(normals)):
                        dot = sum(normals[i][k] * normals[j][k] for k in range(3))
                        if dot < cos_limit:
                            keep = True
                            break
                    if keep:
                        break
            if not keep and length >= edge_long:
                keep = True
            if not keep:
                continue
            edges.extend((used[a], used[b]))
            kept_edges += 1

        tris = len(indices) // 3 - total_tris
        total_tris = len(indices) // 3
        floors[floor]["tri_count"] += tris
        floors[floor]["edge_count"] += kept_edges
        room_stats.append(
            {
                "room": room,
                "floor": floor + 1,
                "triangles": tris,
                "vertices": len(used),
                "edges": kept_edges,
                "source_triangles": len(room_triangles),
            }
        )
        print(
            f"{room:10s} floor {floor + 1}  {tris:7d} tris  "
            f"({len(room_triangles) - tris:6d} filtered)",
            flush=True,
        )

    bounds_min = [min(positions[i::3]) for i in range(3)]
    bounds_max = [max(positions[i::3]) for i in range(3)]

    OUT_BIN.parent.mkdir(parents=True, exist_ok=True)
    with OUT_BIN.open("wb") as f:
        f.write(b"RPDW")
        f.write(
            struct.pack(
                "<IIIIII",
                2,
                len(positions) // 3,
                len(indices) // 3,
                len(edges) // 2,
                3,
                0,
            )
        )
        f.write(struct.pack("<3f", *bounds_min))
        f.write(struct.pack("<3f", *bounds_max))
        for fl in floors:
            f.write(
                struct.pack(
                    "<IIIIff",
                    fl["tri_start"],
                    fl["tri_count"],
                    fl["edge_start"],
                    fl["edge_count"],
                    fl["y_min"] if fl["tri_count"] else 0.0,
                    fl["y_max"] if fl["tri_count"] else 0.0,
                )
            )
        positions.tofile(f)
        indices.tofile(f)
        edges.tofile(f)

    meta = {
        "asset": OUT_BIN.name,
        "version": 2,
        "vertices": len(positions) // 3,
        "triangles": len(indices) // 3,
        "edges": len(edges) // 2,
        "bytes": OUT_BIN.stat().st_size,
        "bounds": {"min": bounds_min, "max": bounds_max},
        "floors": [dict(f, floor=i + 1) for i, f in enumerate(floors)],
        "rooms": room_stats,
        "filters": {
            "ceilings_dropped": dropped_ceiling,
            "clipped_triangles": dropped_clip,
            "duplicate_triangles": duplicate,
            "clip_min": CLIP_MIN,
            "clip_max": CLIP_MAX,
        },
    }
    OUT_JSON.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {OUT_BIN.relative_to(ROOT)}: {meta['vertices']:,} vertices, "
        f"{meta['triangles']:,} triangles, {meta['edges']:,} edges, "
        f"{meta['bytes'] / 1e6:.1f} MB"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep-ceilings", action="store_true")
    parser.add_argument("--no-dedupe", action="store_true")
    parser.add_argument(
        "--reduction",
        type=float,
        default=0.88,
        help="meshoptimizer-style triangle reduction per room (0 disables)",
    )
    parser.add_argument(
        "--edge-min",
        type=float,
        default=0.3,
        help="drop wireframe edges shorter than this many world units",
    )
    parser.add_argument(
        "--edge-angle",
        type=float,
        default=22.0,
        help="keep edges where the adjacent face normals differ by this many degrees",
    )
    parser.add_argument(
        "--edge-long",
        type=float,
        default=2.2,
        help="keep edges at least this long, even when coplanar",
    )
    args = parser.parse_args()
    build(
        keep_ceilings=args.keep_ceilings,
        dedupe=not args.no_dedupe,
        reduction=args.reduction,
        edge_min=args.edge_min,
        edge_angle=args.edge_angle,
        edge_long=args.edge_long,
    )


if __name__ == "__main__":
    main()
