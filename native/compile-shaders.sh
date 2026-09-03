#!/usr/bin/env bash
# Regenerate the sokol-rust shader code (examples/cube/shader.rs) from
# examples/cube/shader.glsl using sokol-shdc.
#
# sokol-shdc is published as a prebuilt binary in the sokol-tools-bin repo:
#   git clone https://github.com/floooh/sokol-tools-bin ~/sokol-tools-bin
#     -> binary at ~/sokol-tools-bin/bin/<platform>/sokol-shdc
#   (<platform> is one of: linux, linux_arm64, osx, osx_arm64, win32)
# Alternatively build it from source: https://github.com/floooh/sokol-tools
#
# If sokol-shdc is not on PATH, set SOKOL_SHDC to its location:
#   export SOKOL_SHDC=~/sokol-tools-bin/bin/linux/sokol-shdc
#
# The `-l` flag lists the target shader dialects. glsl300es is the GLES3.0 /
# WebGL2 dialect used by sokol's Gles3 backend (the default for Emscripten).
set -euo pipefail

if command -v sokol-shdc >/dev/null 2>&1; then
    SHDC="$(command -v sokol-shdc)"
elif [ -n "${SOKOL_SHDC:-}" ]; then
    SHDC="$SOKOL_SHDC"
else
    echo "error: sokol-shdc not found (see header comment for how to get it)."
    exit 1
fi

cd "$(dirname "$0")"

"$SHDC" -i examples/cube/shader.glsl -o examples/cube/shader.rs \
    -l glsl430:glsl300es:metal_macos:hlsl5 \
    -f sokol_rust

echo "Wrote examples/cube/shader.rs"
