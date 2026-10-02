#!/usr/bin/env bash
# Build the sokol-rust game example for WASM (Emscripten).
#
# Prerequisites:
#   1. Rust toolchain with the wasm32-unknown-emscripten target:
#        rustup target add wasm32-unknown-emscripten
#   2. Emscripten SDK (emsdk):
#        git clone https://github.com/emscripten-core/emsdk.git ~/.local/opt/emsdk
#   3. Add to ~/.bashrc: source ~/.local/opt/emsdk/emsdk_env.sh
#
# Emscripten is pinned to 4.0.23: Emscripten >= 5.x changed the stack-function
# export naming that Rust's wasm32-unknown-emscripten std and sokol's JS glue
# rely on, which breaks linking with:
#   "undefined symbol: _emscripten_stack_restore"
set -euo pipefail

EMSDK_DIR="${EMSDK_DIR:-$HOME/.local/opt/emsdk}"
EMSCRIPTEN_VERSION="${EMSCRIPTEN_VERSION:-4.0.23}"

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

emsdk install "$EMSCRIPTEN_VERSION" >/dev/null
emsdk activate "$EMSCRIPTEN_VERSION" >/dev/null
# shellcheck disable=SC1090
source "$EMSDK_DIR/emsdk_env.sh"

NATIVE_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$NATIVE_DIR/.." && pwd)"
cd "$NATIVE_DIR"

cargo build --release --target wasm32-unknown-emscripten --example game

BUILD_DIR="$ROOT_DIR/target/wasm32-unknown-emscripten/release/examples"
ls -lh "$BUILD_DIR"/game.{js,wasm}
