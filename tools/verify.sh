#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHOTS="$ROOT/verification/shots"
LOG=/tmp/entrance-map-wasd.log
CSV=/tmp/entrance-map-wasd.csv
mkdir -p "$SHOTS"
rm -f "$SHOTS"/*.png "$CSV" "$LOG"

cmake -S "$ROOT" -B "$ROOT/build" -DCMAKE_BUILD_TYPE=Debug >/dev/null
cmake --build "$ROOT/build" -j"$(nproc)" >/dev/null

ROOT="$ROOT" SHOTS="$SHOTS" LOG="$LOG" CSV="$CSV" xvfb-run -a -s '-screen 0 1600x1000x24' bash -c '
set -euo pipefail
cd "$ROOT/build"
MAP_DEBUG=1 MAP_FRAMELOG="$CSV" LIBGL_ALWAYS_SOFTWARE=1 ./entrance_map >"$LOG" 2>&1 &
app_pid=$!
trap "kill $app_pid 2>/dev/null || true" EXIT
wid=""
for _ in $(seq 1 60); do
    wid=$(xdotool search --name "R.P.D." 2>/dev/null | head -1 || true)
    if [ -n "$wid" ]; then break; fi
    sleep 0.1
done
if [ -z "$wid" ]; then echo "window not found" >&2; exit 1; fi
sleep 0.8
xdotool mousemove --window "$wid" 900 440
import -window "$wid" "$SHOTS/01-start.png"
xdotool keydown --window "$wid" d
sleep 0.6
import -window "$wid" "$SHOTS/02-walk-right.png"
xdotool keyup --window "$wid" d
xdotool keydown --window "$wid" s
sleep 0.6
import -window "$wid" "$SHOTS/03-walk-back.png"
xdotool keyup --window "$wid" s
xdotool click 3
xdotool keydown --window "$wid" d
sleep 0.8
import -window "$wid" "$SHOTS/04-run-latched.png"
xdotool keyup --window "$wid" d
xdotool keydown --window "$wid" a
sleep 0.7
import -window "$wid" "$SHOTS/05-run-turn.png"
xdotool keyup --window "$wid" a
xdotool click 3
xdotool keydown --window "$wid" d
sleep 0.5
import -window "$wid" "$SHOTS/06-walk-again.png"
xdotool keyup --window "$wid" d
sleep 0.4
import -window "$wid" "$SHOTS/07-stop.png"
xdotool click --repeat 3 4
sleep 0.4
import -window "$wid" "$SHOTS/08-zoomed.png"
xdotool key --window "$wid" r
sleep 0.9
import -window "$wid" "$SHOTS/09-reset.png"
xdotool click --repeat 20 5
sleep 0.6
import -window "$wid" "$SHOTS/10-min-zoom.png"
xdotool click --repeat 30 4
sleep 0.6
import -window "$wid" "$SHOTS/11-max-zoom.png"
xdotool key --window "$wid" Escape
if wait $app_pid; then
    echo "close_exit=0"
else
    close_code=$?
    echo "close_exit=$close_code" >&2
    exit 1
fi
'

if grep -Eq '\[sg\]\[(error|panic)\]|\[sapp\]\[error\]' "$LOG"; then
    echo "sokol log contains errors:" >&2
    grep -E '\[sg\]\[(error|panic)\]|\[sapp\]\[error\]' "$LOG" >&2
    exit 1
fi

python3 - "$CSV" <<'PY'
import csv
import math
import sys

rows = list(csv.DictReader(open(sys.argv[1])))
if len(rows) < 100:
    raise SystemExit("frame log too short")

def f(r, k):
    return float(r[k])

def i(r, k):
    return int(r[k])

if not any(f(r, "speed") == 0.0 for r in rows[:30]):
    raise SystemExit("player was not idle at startup")

walk_right = [r for r in rows if i(r, "run") == 0 and i(r, "d") == 1 and f(r, "speed") > 100.0]
walk_back = [r for r in rows if i(r, "run") == 0 and i(r, "s") == 1 and f(r, "speed") > 100.0]
run_right = [r for r in rows if i(r, "run") == 1 and i(r, "d") == 1 and f(r, "speed") > 240.0]
run_left = [r for r in rows if i(r, "run") == 1 and i(r, "a") == 1 and f(r, "speed") > 240.0]
walk_again = [r for r in rows if i(r, "run") == 0 and i(r, "d") == 1 and f(r, "speed") > 100.0 and f(r, "x") > 150.0]
if not walk_right or not walk_back or not run_right or not run_left:
    raise SystemExit("missing walk or run phase samples")
if not any(abs(f(r, "speed") - 125.0) < 2.0 for r in walk_right):
    raise SystemExit("walking right never reached 125")
if not any(f(r, "x") > 60.0 for r in walk_right):
    raise SystemExit("walking right did not move the player east")
if not any(f(r, "y") < -30.0 for r in walk_back):
    raise SystemExit("walking back did not move the player south")
if not any(abs(f(r, "speed") - 250.0) < 2.0 for r in run_right):
    raise SystemExit("latched run never reached 250")
if not any(130.0 < f(r, "speed") < 240.0 for r in rows):
    raise SystemExit("no intermediate speed sample for the walk/run transition")
if not any(i(r, "run") == 0 for r in rows) or not any(i(r, "run") == 1 for r in rows):
    raise SystemExit("run latch did not toggle")

strafe_dh = 0.0
for a, b in zip(rows, rows[1:]):
    if (i(a, "run") == 0 and i(b, "run") == 0 and
            f(a, "speed") > 50.0 and f(b, "speed") > 50.0 and
            (i(a, "d") == 1 or i(a, "s") == 1 or i(a, "a") == 1 or
             i(b, "d") == 1 or i(b, "s") == 1 or i(b, "a") == 1)):
        dh = math.atan2(math.sin(f(b, "heading") - f(a, "heading")),
                        math.cos(f(b, "heading") - f(a, "heading")))
        strafe_dh = max(strafe_dh, abs(dh))
if strafe_dh > 0.02:
    raise SystemExit("walking changed the facing while strafing by %.3f" % strafe_dh)
if not walk_again:
    raise SystemExit("walking after the run latch did not resume")

def max_rate(sample):
    ids = set(map(id, sample))
    best = 0.0
    for a, b in zip(rows, rows[1:]):
        if id(a) in ids and id(b) in ids:
            dh = math.atan2(math.sin(f(b, "heading") - f(a, "heading")),
                            math.cos(f(b, "heading") - f(a, "heading")))
            best = max(best, abs(dh) / max(f(b, "dt"), 1e-4))
    return best

run_rate = max_rate(run_right + run_left)
if run_rate < 3.0:
    raise SystemExit("running did not turn toward the movement direction: %.2f" % run_rate)
run_heading = [f(r, "heading") for r in run_right + run_left]
if max(run_heading) - min(run_heading) < 2.0:
    raise SystemExit("running did not produce a turning arc")

print("wasd walk=%.1f run=%.1f turn=%.2f walk_heading=%.3f run_heading_span=%.2f" % (
    min(f(r, "speed") for r in walk_right if f(r, "speed") > 100.0),
    max(f(r, "speed") for r in run_right),
    run_rate,
    strafe_dh,
    max(run_heading) - min(run_heading),
))
PY

mean_corner=$(convert "$SHOTS/01-start.png" -crop 40x40+0+0 +repage -format '%[fx:mean]' info:)
if awk -v m="$mean_corner" 'BEGIN { exit !(m > 0.08) }' >/dev/null; then
    echo "top-left background is not dark: mean=$mean_corner" >&2
    exit 1
fi

fps_green=$(convert "$SHOTS/01-start.png" -crop 180x44+1240+0 +repage -format '%[fx:mean.g]' info:)
fps_red=$(convert "$SHOTS/01-start.png" -crop 180x44+1240+0 +repage -format '%[fx:mean.r]' info:)
if awk -v g="$fps_green" -v r="$fps_red" 'BEGIN { exit !(g <= r) }' >/dev/null; then
    echo "top-right FPS text is not green: g=$fps_green r=$fps_red" >&2
    exit 1
fi

circle_max() {
    convert "$1" -crop 5x5+"$2"+"$3" +repage -format '%[fx:maxima]' info:
}
for point in "718 250" "718 490" "598 370" "838 370"; do
    set -- $point
    value=$(circle_max "$SHOTS/01-start.png" "$1" "$2")
    if awk -v v="$value" 'BEGIN { exit !(v > 0.55) }' >/dev/null; then
        echo "analog ring still visible at $1,$2: $value" >&2
        exit 1
    fi
done
cursor_max=$(convert "$SHOTS/01-start.png" -crop 40x40+880+420 +repage -format '%[fx:maxima]' info:)
if awk -v v="$cursor_max" 'BEGIN { exit !(v < 0.25) }' >/dev/null; then
    echo "free cursor ring missing around 900,440: $cursor_max" >&2
    exit 1
fi

gold_center() {
    geom=$(convert "$1" -fx '(r>0.7&&g>0.55&&b<0.55&&r>b*1.55)?1:0' -trim -format '%wx%h%O' info:)
    x=$(echo "$geom" | sed -E 's/.*\+([0-9]+)\+([0-9]+)/\1/')
    y=$(echo "$geom" | sed -E 's/.*\+([0-9]+)\+([0-9]+)/\2/')
    w=$(echo "$geom" | sed -E 's/x.*//')
    h=$(echo "$geom" | sed -E 's/^[0-9]+x([0-9]+).*/\1/')
    echo $((x + w / 2)) $((y + h / 2))
}
for shot in 01-start 02-walk-right 04-run-latched 05-run-turn 06-walk-again 08-zoomed 10-min-zoom 11-max-zoom; do
    set -- $(gold_center "$SHOTS/$shot.png")
    if [ "$1" -lt 714 ] || [ "$1" -gt 726 ] || [ "$2" -lt 366 ] || [ "$2" -gt 378 ]; then
        echo "player arrow is not centered in $shot: $1,$2" >&2
        exit 1
    fi
done

map_bbox() {
    convert "$1" -fill white -opaque '#162731' -fill black +opaque white -trim -format '%wx%h%O' info:
}
map_width() {
    map_bbox "$1" | sed 's/x.*//'
}
map_offset() {
    map_bbox "$1" | sed -E 's/.*\+([0-9]+)\+([0-9]+)/\1,\2/'
}
default_w=$(map_width "$SHOTS/01-start.png")
walk_w=$(map_width "$SHOTS/02-walk-right.png")
run_w=$(map_width "$SHOTS/04-run-latched.png")
if [ $((walk_w - default_w)) -gt 4 ] || [ $((default_w - walk_w)) -gt 4 ] ||
   [ $((run_w - default_w)) -gt 4 ] || [ $((default_w - run_w)) -gt 4 ]; then
    echo "camera follow changed zoom while moving" >&2
    exit 1
fi
if [ "$(map_offset "$SHOTS/01-start.png")" = "$(map_offset "$SHOTS/02-walk-right.png")" ]; then
    echo "camera follow did not move the map while walking" >&2
    exit 1
fi
if [ "$(map_offset "$SHOTS/02-walk-right.png")" = "$(map_offset "$SHOTS/04-run-latched.png")" ]; then
    echo "camera follow did not move the map while running" >&2
    exit 1
fi

zoom_w=$(map_width "$SHOTS/08-zoomed.png")
reset_w=$(map_width "$SHOTS/09-reset.png")
min_w=$(map_width "$SHOTS/10-min-zoom.png")
max_w=$(map_width "$SHOTS/11-max-zoom.png")
if [ "$zoom_w" -le "$default_w" ]; then
    echo "zoom-in did not enlarge the map" >&2
    exit 1
fi
if [ "$min_w" -ge "$default_w" ] || [ "$max_w" -le "$zoom_w" ]; then
    echo "zoom range does not bracket the default: min=$min_w default=$default_w zoom=$zoom_w max=$max_w" >&2
    exit 1
fi
if [ "$reset_w" -lt $((default_w - 3)) ] || [ "$reset_w" -gt $((default_w + 3)) ]; then
    echo "reset did not restore the default zoom width: default=$default_w reset=$reset_w" >&2
    exit 1
fi

for shot in "$SHOTS"/*.png; do
    size=$(identify -format '%wx%h' "$shot")
    mean=$(identify -format '%[fx:mean]' "$shot")
    if ! awk -v m="$mean" 'BEGIN { exit !(m > 0.001) }' >/dev/null; then
        echo "blank screenshot: $shot" >&2
        exit 1
    fi
    printf '%s %s mean=%s\n' "$(basename "$shot")" "$size" "$mean"
done

echo "screenshots in $SHOTS"
