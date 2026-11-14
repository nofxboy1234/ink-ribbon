#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHOTS="$ROOT/verification/shots"
LOG=/tmp/entrance-map-run.log
mkdir -p "$SHOTS"

cmake -S "$ROOT" -B "$ROOT/build" -DCMAKE_BUILD_TYPE=Debug >/dev/null
cmake --build "$ROOT/build" -j"$(nproc)" >/dev/null

ROOT="$ROOT" SHOTS="$SHOTS" LOG="$LOG" xvfb-run -a -s '-screen 0 1600x1000x24' bash -c '
set -euo pipefail
cd "$ROOT/build"
LIBGL_ALWAYS_SOFTWARE=1 ./entrance_map >"$LOG" 2>&1 &
app_pid=$!
trap "kill $app_pid 2>/dev/null || true" EXIT
wid=""
for _ in $(seq 1 60); do
    wid=$(xdotool search --name "R.P.D." 2>/dev/null | head -1 || true)
    if [ -n "$wid" ]; then break; fi
    sleep 0.1
done
if [ -z "$wid" ]; then echo "window not found" >&2; exit 1; fi
sleep 0.6
import -window "$wid" "$SHOTS/01-default.png"
xdotool mousemove --window "$wid" 720 617
sleep 0.5
import -window "$wid" "$SHOTS/02-locked-door.png"
xdotool mousemove --window "$wid" 900 520 click 1
sleep 0.3
import -window "$wid" "$SHOTS/03-moving.png"
sleep 1.2
import -window "$wid" "$SHOTS/04-arrived.png"
xdotool mousemove --window "$wid" 720 450 click 4 click 4
sleep 0.8
import -window "$wid" "$SHOTS/05-zoomed.png"
xdotool mousemove --window "$wid" 700 400 mousedown 1 mousemove 820 470 mouseup 1
sleep 0.6
import -window "$wid" "$SHOTS/06-panned.png"
xdotool key --window "$wid" r
sleep 1.2
import -window "$wid" "$SHOTS/07-reset.png"
'

if grep -Eq '\[sg\]\[(error|panic)\]|\[sapp\]\[error\]' "$LOG"; then
    echo "sokol log contains errors:" >&2
    grep -E '\[sg\]\[(error|panic)\]|\[sapp\]\[error\]' "$LOG" >&2
    exit 1
fi

for shot in "$SHOTS"/*.png; do
    size=$(identify -format '%wx%h' "$shot")
    mean=$(identify -format '%[fx:mean]' "$shot")
    if awk -v m="$mean" 'BEGIN { exit !(m > 0.001) }' >/dev/null; then
        :
    else
        echo "blank screenshot: $shot" >&2
        exit 1
    fi
    printf '%s %s mean=%s\n' "$(basename "$shot")" "$size" "$mean"
done

echo "screenshots in $SHOTS"
