"""Minimal RE Engine KPKA v4 reader for the RE2 RT install.

The game index is read in place. Only the paths passed in are decompressed.
The PAK lookup (Murmur3 over UTF-16LE lower/upper names) follows the format
notes from the `reze` extraction project.
"""

from __future__ import annotations

import dataclasses
import os
import pathlib
import struct
import zlib

try:
    import zstandard
except ImportError as exc:  # pragma: no cover - clear error for new machines
    raise SystemExit(
        "zstandard is required: uv run --with zstandard tools/extract_rpd.py"
    ) from exc

GAME_DIR = pathlib.Path(
    os.environ.get(
        "RE2_GAME_DIR",
        "/home/dylan/.local/share/Steam/steamapps/common/RESIDENT EVIL 2  BIOHAZARD RE2",
    )
)
ARCHIVES = (
    "re_chunk_000.pak",
    "re_chunk_000.pak.patch_001.pak",
    "re_chunk_000.pak.patch_002.pak",
)


def _rotl32(value: int, shift: int) -> int:
    return ((value << shift) | (value >> (32 - shift))) & 0xFFFFFFFF


def _fmix32(value: int) -> int:
    value ^= value >> 16
    value = (value * 0x85EBCA6B) & 0xFFFFFFFF
    value ^= value >> 13
    value = (value * 0xC2B2AE35) & 0xFFFFFFFF
    value ^= value >> 16
    return value


def _murmur3_32(data: bytes, seed: int = 0xFFFFFFFF) -> int:
    c1, c2 = 0xCC9E2D51, 0x1B873593
    h1 = seed
    blocks = len(data) // 4
    for i in range(blocks):
        k1 = struct.unpack_from("<I", data, i * 4)[0]
        k1 = (k1 * c1) & 0xFFFFFFFF
        k1 = _rotl32(k1, 15)
        k1 = (k1 * c2) & 0xFFFFFFFF
        h1 ^= k1
        h1 = _rotl32(h1, 13)
        h1 = (h1 * 5 + 0xE6546B64) & 0xFFFFFFFF
    tail = data[blocks * 4 :]
    if tail:
        k1 = 0
        for i, byte in enumerate(tail):
            k1 |= byte << (8 * i)
        k1 = (k1 * c1) & 0xFFFFFFFF
        k1 = _rotl32(k1, 15)
        k1 = (k1 * c2) & 0xFFFFFFFF
        h1 ^= k1
    h1 ^= len(data)
    return _fmix32(h1)


def path_hash(path: str) -> int:
    lo = _murmur3_32(path.lower().encode("utf-16-le"))
    hi = _murmur3_32(path.upper().encode("utf-16-le"))
    return (lo << 32) | hi


@dataclasses.dataclass(frozen=True)
class PakEntry:
    path: str
    archive: pathlib.Path
    offset: int
    compressed_size: int
    uncompressed_size: int
    compression: int


def _entries(archive: pathlib.Path, wanted: dict[int, str]):
    with archive.open("rb") as f:
        magic, major, _minor, feature, count, _ = struct.unpack("<IBBhII", f.read(16))
        if magic != 0x414B504B or major != 4 or feature != 0:
            raise ValueError(f"unsupported PAK: {archive}")
        f.seek(16)
        table = f.read(count * 48)
    for i in range(count):
        lo, hi, off, csize, usize, attrs, _ = struct.unpack_from(
            "<IIQQQQQ", table, i * 48
        )
        key = (lo << 32) | hi
        name = wanted.get(key)
        if name is None:
            continue
        yield PakEntry(
            path=name,
            archive=archive,
            offset=off,
            compressed_size=csize,
            uncompressed_size=usize,
            compression=attrs & 0xF,
        )


def find(paths: list[str], game_dir: pathlib.Path = GAME_DIR) -> dict[str, PakEntry]:
    wanted = {path_hash(path): path for path in paths}
    found: dict[str, PakEntry] = {}
    for name in ARCHIVES:
        archive = game_dir / name
        if not archive.is_file():
            continue
        for entry in _entries(archive, wanted):
            found[entry.path] = entry
    missing = wanted.values() - found.keys()
    if missing:
        raise SystemExit("missing PAK entries:\n  " + "\n  ".join(sorted(missing)))
    return found


def read(entry: PakEntry) -> bytes:
    with entry.archive.open("rb") as f:
        f.seek(entry.offset)
        raw = f.read(entry.compressed_size)
    if entry.compression == 0:
        return raw
    if entry.compression == 1:
        return zlib.decompress(raw, wbits=-zlib.MAX_WBITS)
    if entry.compression == 2:
        return zstandard.ZstdDecompressor().decompress(raw)
    raise ValueError(f"unknown PAK compression {entry.compression}: {entry.path}")
