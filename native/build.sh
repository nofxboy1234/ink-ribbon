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
node "${ROOT}/tools/gen_item_registry.mjs"
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
    -sEXPORTED_FUNCTIONS=_main,_malloc,_free,_rpd_load_scene,_rpd_get_camera,_rpd_get_camera_model,_rpd_set_orbit,_rpd_animate_orbit,_rpd_recenter,_rpd_get_view_proj,_rpd_marker_clear,_rpd_marker_add,_rpd_marker_set_visible,_rpd_marker_set_position,_rpd_marker_set_color,_rpd_marker_set_rotation,_rpd_marker_count,_rpd_set_player_position,_rpd_set_view_mode,_rpd_debug_blend,_rpd_debug_floors,_rpd_plan_active_floor,_rpd_plan_add_target,_rpd_plan_add_target_node,_rpd_plan_route,_rpd_popup_state,_rpd_popup_choice,_rpd_popup_label,_rpd_popup_message,_rpd_popup_close,_rpd_item_count,_rpd_item,_rpd_item_name,_rpd_item_room,_rpd_item_icon,_rpd_item_action,_rpd_item_hint,_rpd_item_act,_rpd_item_enter_code,_rpd_item_grant_external,_rpd_item_has_code,_rpd_plan_item_blocked,_rpd_item_index_for_id,_rpd_item_available,_rpd_inventory_item,_rpd_inventory_count,_rpd_inventory \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32

mv "${ROOT}/src/wasm/rpd.wasm" "${ROOT}/public/rpd/rpd.wasm"
chmod 644 "${ROOT}/public/rpd/rpd.wasm" "${ROOT}/src/wasm/rpd.js"
ls -lh "${ROOT}/src/wasm/rpd.js" "${ROOT}/public/rpd/rpd.wasm"
