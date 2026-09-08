#!/usr/bin/env bash
# Build the sokol-rust map example for WASM (Emscripten).
#
# Prerequisites:
#   1. Rust toolchain with the wasm32-unknown-emscripten target:
#        rustup target add wasm32-unknown-emscripten
#   2. Emscripten SDK (emsdk):
#        git clone https://github.com/emscripten-core/emsdk.git ~/.local/opt/emsdk
#   3. Add to ~/.bashrc: source ~/.local/opt/emsdk/emsdk_env.sh
#
# Usage:
#   ./build-wasm.sh
#
# Emscripten is pinned to 4.0.23: Emscripten >= 5.x changed the stack-function
# export naming that Rust's wasm32-unknown-emscripten std and sokol's JS glue
# rely on, which breaks linking with:
#   "undefined symbol: _emscripten_stack_restore"
set -euo pipefail

EMSDK_DIR="${EMSDK_DIR:-$HOME/.local/opt/emsdk}"
EMSCRIPTEN_VERSION="${EMSCRIPTEN_VERSION:-4.0.23}"

# Activate emsdk if not already in PATH
if ! command -v emcc &>/dev/null; then
    if [ -f "$EMSDK_DIR/emsdk_env.sh" ]; then
        source "$EMSDK_DIR/emsdk_env.sh"
    else
        echo "Error: emsdk not found at $EMSDK_DIR/"
        echo "Install it: git clone https://github.com/emscripten-core/emsdk.git $EMSDK_DIR"
        echo "Then: cd $EMSDK_DIR && ./emsdk install $EMSCRIPTEN_VERSION && ./emsdk activate $EMSCRIPTEN_VERSION"
        exit 1
    fi
fi

# Pin a known-good Emscripten version (see header comment). These are cheap
# no-ops when the pinned version is already installed and active.
emsdk install "$EMSCRIPTEN_VERSION" >/dev/null
emsdk activate "$EMSCRIPTEN_VERSION" >/dev/null
# shellcheck disable=SC1090
source "$EMSDK_DIR/emsdk_env.sh"

NATIVE_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$NATIVE_DIR/.." && pwd)"
cd "$NATIVE_DIR"

# Build the release wasm map. The generated room/HUD textures are embedded in
# the Rust binary, so native and wasm always use the same bytes.
cargo build --release --target wasm32-unknown-emscripten --example map

BUILD_DIR="$ROOT_DIR/target/wasm32-unknown-emscripten/release/examples"
echo ""
echo "Build complete: target/wasm32-unknown-emscripten/release/examples/map.js"
ls -lh "$BUILD_DIR"/map.{js,wasm}
