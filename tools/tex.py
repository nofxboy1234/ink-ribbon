"""RE Engine TEX container reader.

The header layout follows the shipped `.tex.34` resources. Only the base mip is
decoded. Alpha is preserved by default because UI icons use it as a cutout; the
item albedo path passes ``opaque=True`` because those maps carry a constant
alpha instead of a mask.
"""

from __future__ import annotations

import dataclasses
import struct

TEX_MAGIC = 0x00584554

LAYOUT_LEGACY = 0
LAYOUT_INLINE = 1
LAYOUT_STORED = 2

BC_DECODERS = {
    71: "decode_bc1",
    72: "decode_bc1",
    74: "decode_bc2",
    75: "decode_bc2",
    77: "decode_bc3",
    78: "decode_bc3",
    98: "decode_bc7",
    99: "decode_bc7",
}

UNCOMPRESSED = {
    28: "rgba8",
    29: "rgba8",
    87: "bgra8",
    91: "bgra8",
}


class TexError(ValueError):
    pass


@dataclasses.dataclass(frozen=True)
class Image:
    width: int
    height: int
    rgba: bytes


def _layout(version: int) -> int:
    if version in (1, 34, 35):
        return LAYOUT_STORED
    if version >= 2:
        return LAYOUT_INLINE
    return LAYOUT_LEGACY


def decode(data: bytes, *, opaque: bool = False) -> Image:
    if len(data) < 40:
        raise TexError("payload shorter than a TEX header")
    if struct.unpack_from("<I", data, 0)[0] != TEX_MAGIC:
        raise TexError("bad TEX magic")
    version = struct.unpack_from("<i", data, 4)[0]
    width, height, _depth, count_a, count_b, fmt, _swizzle, _cube, _flags = (
        struct.unpack_from("<hhhBBiiIi", data, 8)
    )
    layout = _layout(version)
    if layout == LAYOUT_LEGACY:
        mips_at, mip_count, image_count = 32, count_a, count_b
    else:
        packed = count_a | count_b << 8
        mips_at, mip_count, image_count = 40, packed >> 12, packed & 0xFFF
    if mip_count <= 0 or image_count <= 0:
        raise TexError(f"invalid mip/image count {mip_count}/{image_count}")
    entries = mip_count * image_count
    if mips_at + 16 * entries > len(data):
        raise TexError("mip table past the end of the payload")
    offset, _pitch, size = struct.unpack_from("<qii", data, mips_at)
    if offset < mips_at + 16 * entries or offset + size > len(data):
        raise TexError("base mip outside the payload")
    if width <= 0 or height <= 0:
        raise TexError(f"invalid dimensions {width}x{height}")

    payload = data[offset : offset + size]
    rgba = _decode_format(fmt, width, height, payload)
    return Image(width, height, _opaque(rgba) if opaque else rgba)


def _decode_format(fmt: int, width: int, height: int, payload: bytes) -> bytes:
    name = BC_DECODERS.get(fmt)
    if name is not None:
        import texture2ddecoder

        fn = getattr(texture2ddecoder, name)
        raw = fn(payload, width, height)
        return _swap_red_blue(raw)
    kind = UNCOMPRESSED.get(fmt)
    if kind == "rgba8":
        return payload[: width * height * 4]
    if kind == "bgra8":
        return _swap_red_blue(payload[: width * height * 4])
    raise TexError(f"unsupported TEX format {fmt}")


def _swap_red_blue(data) -> bytes:
    out = bytearray(data)
    out[0::4], out[2::4] = out[2::4], out[0::4]
    return bytes(out)


def _opaque(rgba: bytes) -> bytes:
    out = bytearray(rgba)
    out[3::4] = b"\xff" * (len(out) // 4)
    return bytes(out)
