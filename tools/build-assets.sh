#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/assets/src"
OUT="$ROOT/assets"

cd "$SRC"
PYTHONPATH="$SRC" kritarunner -s build_assets -f __main__

xvfb-run -a -s '-screen 0 1280x800x24' bash -c '
set -euo pipefail
cd "$1"
for name in map door_service door_locked door_locked_hover player_arrow player_glow pulse_ring cursor_ring tooltip legend_searching legend_complete; do
    krita --nosplash --export --export-filename "$2/$name.png" "$1/$name.kra" >/dev/null 2>&1
    test -s "$2/$name.png"
done
' _ "$SRC" "$OUT"

for name in map door_service door_locked door_locked_hover player_arrow player_glow pulse_ring cursor_ring tooltip legend_searching legend_complete; do
    identify "$OUT/$name.png" >/dev/null
    printf '%s %s\n' "$name" "$(identify -format '%wx%h' "$OUT/$name.png")"
done
