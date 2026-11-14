#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHOTS="$ROOT/verification/shots"
LOG=/tmp/entrance-map-run.log
mkdir -p "$SHOTS"
rm -f "$SHOTS"/*.png

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
import -window "$wid" "$SHOTS/06-left-drag.png"
xdotool mousemove --window "$wid" 700 400 mousedown 2 mousemove 820 470 mouseup 2
sleep 0.6
import -window "$wid" "$SHOTS/07-panned.png"
xdotool key --window "$wid" r
sleep 1.2
import -window "$wid" "$SHOTS/08-reset.png"
'

if grep -Eq '\[sg\]\[(error|panic)\]|\[sapp\]\[error\]' "$LOG"; then
    echo "sokol log contains errors:" >&2
    grep -E '\[sg\]\[(error|panic)\]|\[sapp\]\[error\]' "$LOG" >&2
    exit 1
fi

mean_corner=$(convert "$SHOTS/01-default.png" -crop 40x40+0+0 +repage -format '%[fx:mean]' info:)
if awk -v m="$mean_corner" 'BEGIN { exit !(m > 0.08) }' >/dev/null; then
    echo "top-left background is not dark: mean=$mean_corner" >&2
    exit 1
fi

fps_green=$(convert "$SHOTS/01-default.png" -crop 180x44+1240+0 +repage -format '%[fx:mean.g]' info:)
fps_red=$(convert "$SHOTS/01-default.png" -crop 180x44+1240+0 +repage -format '%[fx:mean.r]' info:)
if awk -v g="$fps_green" -v r="$fps_red" 'BEGIN { exit !(g <= r) }' >/dev/null; then
    echo "top-right FPS text is not green: g=$fps_green r=$fps_red" >&2
    exit 1
fi

map_bbox() {
    convert "$1" -fill white -opaque '#162731' -fill black +opaque white -trim -format '%wx%h%O' info:
}

zoom_bbox=$(map_bbox "$SHOTS/05-zoomed.png")
left_bbox=$(map_bbox "$SHOTS/06-left-drag.png")
pan_bbox=$(map_bbox "$SHOTS/07-panned.png")
if [ "$zoom_bbox" != "$left_bbox" ]; then
    echo "left drag changed the map: $zoom_bbox -> $left_bbox" >&2
    exit 1
fi
if [ "$zoom_bbox" = "$pan_bbox" ]; then
    echo "middle drag did not pan the map: $zoom_bbox" >&2
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
