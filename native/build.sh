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

SHDC="${SOKOL_SHDC:-$HOME/.cache/sokol-tools-bin/bin/linux/sokol-shdc}"
if [[ ! -x "${SHDC}" ]]; then
    SHDC="$(command -v sokol-shdc || true)"
fi
if [[ -z "${SHDC}" ]]; then
    echo "sokol-shdc not found; set SOKOL_SHDC." >&2
    exit 1
fi

mkdir -p "${ROOT}/public/rpd" "${ROOT}/src/wasm" "${ROOT}/native/gen"
"${SHDC}" -i "${ROOT}/native/src/rpd_shaders.glsl" \
    -o "${ROOT}/native/gen/rpd_shaders_gen.h" \
    -l glsl300es -f sokol

emcc "${ROOT}/native/main.c" "${ROOT}"/native/src/*.c \
    -o "${ROOT}/src/wasm/rpd.js" \
    -I "${ROOT}/native/src" \
    -I "${ROOT}/native/gen" \
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
    -sEXPORTED_FUNCTIONS=_main,_malloc,_free,_rpd_load_scene,_rpd_get_camera,_rpd_set_orbit,_rpd_animate_orbit,_rpd_get_view_proj,_rpd_marker_clear,_rpd_marker_add,_rpd_marker_set_visible,_rpd_marker_set_position,_rpd_marker_set_color,_rpd_marker_set_rotation,_rpd_marker_count,_rpd_set_player_position,_rpd_set_view_mode,_rpd_map_set_camera,_rpd_debug_blend,_rpd_plan_route,_rpd_popup_state,_rpd_popup_choice,_rpd_popup_label,_rpd_popup_message \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32

mv "${ROOT}/src/wasm/rpd.wasm" "${ROOT}/public/rpd/rpd.wasm"
chmod 644 "${ROOT}/public/rpd/rpd.wasm" "${ROOT}/src/wasm/rpd.js"
ls -lh "${ROOT}/src/wasm/rpd.js" "${ROOT}/public/rpd/rpd.wasm"
