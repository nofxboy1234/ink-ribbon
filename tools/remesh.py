"""Parser for RE Engine `.mesh` files used by Resident Evil 2 RT.

Only the parts needed to pull static level geometry are implemented: the file
header, the LOD/mesh-group table, the material subdivisions, and the vertex and
index buffers. The layout follows the RE2 RT `.mesh.2109108288` variant.
"""

from __future__ import annotations

import dataclasses
import struct

MAGIC = 0x4853454D  # "MESH"
RE2RT_VERSION = 2109108288
RE2RT_INTERNAL_VERSION = 21041600


@dataclasses.dataclass(frozen=True)
class VertexElement:
    typing: int
    stride: int
    start: int


@dataclasses.dataclass(frozen=True)
class Submesh:
    material: int
    is_quad: bool
    vertex_buffer: int
    index_count: int
    index_start: int
    vertex_start: int


@dataclasses.dataclass(frozen=True)
class MeshGroup:
    viscon: int
    vertex_count: int
    face_count: int
    submeshes: tuple[Submesh, ...]


@dataclasses.dataclass(frozen=True)
class LodGroup:
    distance: float
    groups: tuple[MeshGroup, ...]


@dataclasses.dataclass(frozen=True)
class Mesh:
    version: int
    bounds_min: tuple[float, float, float]
    bounds_max: tuple[float, float, float]
    lods: tuple[LodGroup, ...]
    vertex_buffer: bytes
    index_buffer: bytes
    vertex_elements: tuple[VertexElement, ...]
    has_32bit_indices: bool


def _u8(data: bytes, offset: int) -> int:
    return data[offset]


def _u16(data: bytes, offset: int) -> int:
    return struct.unpack_from("<H", data, offset)[0]


def _s16(data: bytes, offset: int) -> int:
    return struct.unpack_from("<h", data, offset)[0]


def _u32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def _u64(data: bytes, offset: int) -> int:
    return struct.unpack_from("<Q", data, offset)[0]


def _f32(data: bytes, offset: int) -> float:
    return struct.unpack_from("<f", data, offset)[0]


def _align16(offset: int) -> int:
    return (offset + 15) & ~15


def parse(data: bytes) -> Mesh:
    if len(data) < 0x80 or _u32(data, 0) != MAGIC:
        raise ValueError("not an RE mesh file")
    version = _u32(data, 4)
    if version != RE2RT_INTERNAL_VERSION:
        raise ValueError(f"unsupported mesh version {version}")

    mesh_group_offset = _u64(data, 0x18)
    mesh_offset = _u64(data, 0x50)

    # Main mesh header.
    o = mesh_group_offset
    lod_count = _u8(data, o)
    total_mesh_count = _u16(data, o + 4)
    has_32bit = _u8(data, o + 6) != 0
    o += 8
    _sphere = struct.unpack_from("<4f", data, o)
    o += 16
    bounds_min = struct.unpack_from("<3f", data, o)
    o += 16
    bounds_max = struct.unpack_from("<3f", data, o)
    o += 16
    o += 8  # offsetOffset
    lod_offsets = [_u64(data, o + 8 * i) for i in range(lod_count)]

    lods: list[LodGroup] = []
    for lod_offset in lod_offsets:
        p = lod_offset
        group_count = _u8(data, p)
        distance = _f32(data, p + 4)
        p = _align16(p + 16 + 8 * group_count)
        groups: list[MeshGroup] = []
        for _ in range(group_count):
            viscon = _u8(data, p)
            submesh_count = _u8(data, p + 1)
            vertex_count = _u32(data, p + 8)
            face_count = _u32(data, p + 12)
            p += 16
            submeshes: list[Submesh] = []
            for _ in range(submesh_count):
                # RE2 RT material subdivision: 24 bytes (the 20-byte variant is
                # pre-RE8).
                submeshes.append(
                    Submesh(
                        material=_u8(data, p),
                        is_quad=_u8(data, p + 1) != 0,
                        vertex_buffer=_u8(data, p + 2),
                        index_count=_u32(data, p + 4),
                        index_start=_u32(data, p + 8),
                        vertex_start=_u32(data, p + 12),
                    )
                )
                p += 24
            groups.append(
                MeshGroup(
                    viscon=viscon,
                    vertex_count=vertex_count,
                    face_count=face_count,
                    submeshes=tuple(submeshes),
                )
            )
        lods.append(LodGroup(distance=distance, groups=tuple(groups)))

    # Buffer header.
    o = mesh_offset
    element_offset = _u64(data, o)
    vertex_buffer_offset = _u64(data, o + 8)
    face_buffer_offset = _u64(data, o + 16)
    vertex_buffer_size = _u32(data, o + 32)
    face_buffer_size = _u32(data, o + 36)
    element_count = _u16(data, o + 42)

    elements = tuple(
        VertexElement(
            typing=_u16(data, element_offset + 8 * i),
            stride=_u16(data, element_offset + 8 * i + 2),
            start=_u32(data, element_offset + 8 * i + 4),
        )
        for i in range(element_count)
    )

    return Mesh(
        version=version,
        bounds_min=tuple(round(v, 4) for v in bounds_min),
        bounds_max=tuple(round(v, 4) for v in bounds_max),
        lods=tuple(lods),
        vertex_buffer=data[
            vertex_buffer_offset : vertex_buffer_offset + vertex_buffer_size
        ],
        index_buffer=data[face_buffer_offset : face_buffer_offset + face_buffer_size],
        vertex_elements=elements,
        has_32bit_indices=has_32bit,
    )


def group_vertex_base(group: MeshGroup) -> int:
    """First vertex of a mesh group in the shared vertex buffer.

    Groups each own a consecutive slice of the vertex buffer. Submesh
    `vertex_start` values are absolute; face indices are relative to the
    group slice.
    """
    return min(sub.vertex_start for sub in group.submeshes)


def positions(mesh: Mesh, group: MeshGroup):
    """Return the group's vertex positions as a list of (x, y, z)."""
    position = next((e for e in mesh.vertex_elements if e.typing == 0), None)
    if position is None:
        raise ValueError("mesh has no position element")
    unpack = struct.Struct("<3f").unpack_from
    buf = mesh.vertex_buffer
    base = position.start
    stride = position.stride
    group_base = group_vertex_base(group)
    return [
        unpack(buf, base + (group_base + i) * stride)
        for i in range(group.vertex_count)
    ]


def triangles(mesh: Mesh, group: MeshGroup):
    """Yield (a, b, c) vertex indices relative to the group's vertex pool."""
    index_size = 4 if mesh.has_32bit_indices else 2
    fmt = "<%dI" if index_size == 4 else "<%dH"
    buf = mesh.index_buffer
    group_base = group_vertex_base(group)
    for sub in group.submeshes:
        if sub.is_quad:
            raise ValueError("quad material subdivisions are not supported")
        count = sub.index_count
        if count % 3 != 0:
            raise ValueError(f"index count {count} is not a multiple of 3")
        raw = struct.unpack_from(fmt % count, buf, sub.index_start * index_size)
        for i in range(0, count, 3):
            # Face indices are relative to this subdivision's vertex slice.
            local = sub.vertex_start - group_base
            yield (raw[i] + local, raw[i + 1] + local, raw[i + 2] + local)
