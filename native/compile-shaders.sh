#!/usr/bin/env bash
# Regenerate the sokol-rust shader code (examples/cube/shader.rs) from
# examples/cube/shader.glsl using sokol-shdc.
#
# sokol-shdc is a prebuilt binary published in the sokol-tools-bin repo:
#   https://github.com/floooh/sokol-tools-bin
#
# This script resolves the sokol-shdc binary in this order:
#   1. `sokol-shdc` on PATH
#   2. `$SOKOL_SHDC` pointing at the binary
#   3. an existing checkout at `$SOKOL_TOOLS_BIN` (default ~/.cache/sokol-tools-bin)
#   4. otherwise it clones sokol-tools-bin into ~/.cache/sokol-tools-bin
#
# The `-l` flag lists the target shader dialects. glsl300es is the GLES3.0 /
# WebGL2 dialect used by sokol's Gles3 backend (the default for Emscripten).
set -euo pipefail

# Map the host platform to sokol-tools-bin's bin/ directory names.
case "$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | tr '[:upper:]' '[:lower:]')" in
    linux-x86_64)                          SHDC_PLATFORM="linux" ;;
    linux-aarch64|linux-arm64)             SHDC_PLATFORM="linux_arm64" ;;
    darwin-x86_64)                         SHDC_PLATFORM="osx" ;;
    darwin-arm64)                          SHDC_PLATFORM="osx_arm64" ;;
    mingw*|msys*|cygwin*)                  SHDC_PLATFORM="win32" ;;
    *) echo "error: unsupported platform for sokol-shdc (uname: $(uname -s) $(uname -m))"; exit 1 ;;
esac

SOKOL_TOOLS_BIN="${SOKOL_TOOLS_BIN:-$HOME/.cache/sokol-tools-bin}"

find_shdc() {
    if command -v sokol-shdc >/dev/null 2>&1; then
        command -v sokol-shdc
    elif [ -n "${SOKOL_SHDC:-}" ]; then
        echo "$SOKOL_SHDC"
    elif [ -x "$SOKOL_TOOLS_BIN/bin/$SHDC_PLATFORM/sokol-shdc" ]; then
        echo "$SOKOL_TOOLS_BIN/bin/$SHDC_PLATFORM/sokol-shdc"
    else
        return 1
    fi
}

SHDC="$(find_shdc || true)"
if [ -z "$SHDC" ]; then
    echo "sokol-shdc not found; fetching sokol-tools-bin into $SOKOL_TOOLS_BIN ..."
    if ! command -v git >/dev/null 2>&1; then
        echo "error: git is required to fetch sokol-tools-bin"
        exit 1
    fi
    TMP_BIN="${SOKOL_TOOLS_BIN}.tmp.$$"
    mkdir -p "$(dirname "$SOKOL_TOOLS_BIN")"
    if ! git clone --depth 1 https://github.com/floooh/sokol-tools-bin.git "$TMP_BIN" >/dev/null 2>&1; then
        echo "error: could not clone sokol-tools-bin into $TMP_BIN"
        echo "       install sokol-shdc manually and set SOKOL_SHDC, or put it on PATH"
        rm -rf "$TMP_BIN"
        exit 1
    fi
    rm -rf "$SOKOL_TOOLS_BIN"
    mv "$TMP_BIN" "$SOKOL_TOOLS_BIN"
    SHDC="$SOKOL_TOOLS_BIN/bin/$SHDC_PLATFORM/sokol-shdc"
    chmod +x "$SHDC" 2>/dev/null || true
fi

if [ ! -x "$SHDC" ]; then
    echo "error: sokol-shdc not found or not executable at: $SHDC"
    echo "       install it manually and set SOKOL_SHDC, or put it on PATH"
    exit 1
fi

cd "$(dirname "$0")"

"$SHDC" -i examples/cube/shader.glsl -o examples/cube/shader.rs \
    -l glsl430:glsl300es:metal_macos:hlsl5 \
    -f sokol_rust

echo "Wrote examples/cube/shader.rs"
