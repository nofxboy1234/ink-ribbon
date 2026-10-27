#!/usr/bin/env bash
# Build the sokol RPD renderer to a self-contained ES module + wasm.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMSDK="${EMSDK:-$HOME/emsdk}"

if [[ ! -f "${EMSDK}/emsdk_env.sh" ]]; then
    echo "Emscripten SDK not found at ${EMSDK}; install it or set EMSDK." >&2
    exit 1
fi

# shellcheck disable=SC1091
source "${EMSDK}/emsdk_env.sh" >/dev/null 2>&1

mkdir -p "${ROOT}/public/rpd" "${ROOT}/src/wasm"
emcc "${ROOT}/native/main.c" \
    -o "${ROOT}/src/wasm/rpd.js" \
    -I "${ROOT}/native/third_party/sokol" \
    -O3 \
    -sUSE_WEBGL2=1 \
    -sMIN_WEBGL_VERSION=2 \
    -sMAX_WEBGL_VERSION=2 \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sEXPORT_NAME=createRpdModule \
    -sENVIRONMENT=web \
    -sFILESYSTEM=0 \
    -sALLOW_MEMORY_GROWTH=1 \
    -sINITIAL_MEMORY=67108864 \
    -sMAXIMUM_MEMORY=1073741824 \
    -sNO_EXIT_RUNTIME=1 \
    -sEXPORTED_FUNCTIONS=_main,_malloc,_free,_rpd_load_scene,_rpd_set_blockout,_rpd_set_blockout2 \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32

mv "${ROOT}/src/wasm/rpd.wasm" "${ROOT}/public/rpd/rpd.wasm"
chmod 644 "${ROOT}/public/rpd/rpd.wasm" "${ROOT}/src/wasm/rpd.js"
ls -lh "${ROOT}/src/wasm/rpd.js" "${ROOT}/public/rpd/rpd.wasm"
