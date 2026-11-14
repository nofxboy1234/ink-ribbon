#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHOTS="$ROOT/verification/shots"
LOG=/tmp/entrance-map-joy.log
CSV=/tmp/entrance-map-joy.csv
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
import -window "$wid" "$SHOTS/01-start.png"
xdotool mousemove --window "$wid" 720 372
sleep 0.35
import -window "$wid" "$SHOTS/02-center.png"
xdotool mousemove --window "$wid" 760 372
sleep 0.6
import -window "$wid" "$SHOTS/03-walk.png"
xdotool mousemove --window "$wid" 810 372
sleep 0.6
import -window "$wid" "$SHOTS/04-run.png"
xdotool mousedown 1
xdotool mousemove --window "$wid" 760 332
sleep 0.5
import -window "$wid" "$SHOTS/05-turn-walk.png"
xdotool mousemove --window "$wid" 810 372
sleep 1.8
import -window "$wid" "$SHOTS/06-turn-run.png"
xdotool mouseup 1
xdotool mousemove --window "$wid" 630 372
sleep 0.6
import -window "$wid" "$SHOTS/07-strafe.png"
xdotool mousemove --window "$wid" 720 372
sleep 0.5
import -window "$wid" "$SHOTS/08-stop.png"
xdotool mousemove --window "$wid" 720 372
xdotool click --repeat 3 4
sleep 0.4
import -window "$wid" "$SHOTS/09-zoomed.png"
xdotool key --window "$wid" r
sleep 0.9
import -window "$wid" "$SHOTS/10-reset.png"
xdotool click --repeat 20 5
sleep 0.6
import -window "$wid" "$SHOTS/11-min-zoom.png"
xdotool click --repeat 30 4
sleep 0.6
import -window "$wid" "$SHOTS/12-max-zoom.png"
kill $app_pid 2>/dev/null || true
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

active = [r for r in rows if i(r, "stick_active") == 1]
if not active:
    raise SystemExit("stick never became active")
if not any(f(r, "speed") == 0.0 and i(r, "stick_active") == 0 for r in rows[:30]):
    raise SystemExit("player was not idle at startup")

walk_strafe = [r for r in active if i(r, "stick_face") == 0 and 20.0 < f(r, "stick_len") < 59.0]
run_strafe = [r for r in active if i(r, "stick_face") == 0 and f(r, "stick_len") > 61.0]
walk_turn = [r for r in active if i(r, "stick_face") == 1 and f(r, "stick_len") < 59.0]
run_turn = [r for r in active if i(r, "stick_face") == 1 and f(r, "stick_len") > 61.0]
if not walk_strafe or not run_strafe or not walk_turn or not run_turn:
    raise SystemExit("missing walk/run strafe or turn samples")
if not any(abs(f(r, "speed") - 125.0) < 2.0 for r in walk_strafe):
    raise SystemExit("walk strafe never reached 125")
if not any(abs(f(r, "speed") - 250.0) < 2.0 for r in run_strafe):
    raise SystemExit("run strafe never reached 250")
if not any(i(r, "stick_running") == 0 for r in walk_strafe) or not any(i(r, "stick_running") == 1 for r in run_strafe):
    raise SystemExit("walk/run threshold did not separate strafe samples")
if not any(130.0 < f(r, "speed") < 240.0 for r in rows):
    raise SystemExit("no intermediate speed sample for the walk/run transition")
if not any(i(r, "stick_face") == 1 and f(r, "speed") > 240.0 for r in run_turn):
    raise SystemExit("left-held run did not stay at run speed")

def max_heading_rate(pred):
    best = 0.0
    for a, b in zip(rows, rows[1:]):
        if not (pred(a) and pred(b)):
            continue
        dh = math.atan2(math.sin(f(b, "heading") - f(a, "heading")),
                        math.cos(f(b, "heading") - f(a, "heading")))
        dt = max(f(b, "dt"), 1e-4)
        best = max(best, abs(dh) / dt)
    return best

walk_rate = max_heading_rate(
    lambda r: i(r, "stick_active") == 1 and i(r, "stick_face") == 1 and f(r, "stick_len") < 59.0)
run_rate = max_heading_rate(
    lambda r: i(r, "stick_active") == 1 and i(r, "stick_face") == 1 and f(r, "stick_len") > 61.0)
if walk_rate < 0.5:
    raise SystemExit("walking left-held turn produced no heading change")
if run_rate <= walk_rate + 0.5:
    raise SystemExit("run turn did not exceed walk turn: walk=%.2f run=%.2f" % (walk_rate, run_rate))

runs = []
current = []
for r in rows:
    if i(r, "stick_active") == 1 and i(r, "stick_face") == 1 and f(r, "stick_len") > 61.0:
        current.append(r)
    elif current:
        runs.append(current)
        current = []
if current:
    runs.append(current)
if not runs:
    raise SystemExit("no run-turn phase")
longest = max(runs, key=len)
turn_total = 0.0
for a, b in zip(longest, longest[1:]):
    turn_total += abs(math.atan2(math.sin(f(b, "heading") - f(a, "heading")),
                                 math.cos(f(b, "heading") - f(a, "heading"))))
if turn_total < 2.0 * math.pi:
    raise SystemExit("run turn did not complete a circle: %.2f rad" % turn_total)

strafe_rows = [r for r in active if i(r, "stick_face") == 0 and f(r, "speed") > 50.0]
if not strafe_rows:
    raise SystemExit("no moving strafe samples")
strafe_dh = 0.0
for a, b in zip(rows, rows[1:]):
    if (i(a, "stick_face") == 0 and i(b, "stick_face") == 0 and
            i(a, "stick_active") == 1 and i(b, "stick_active") == 1 and
            f(a, "speed") > 50.0 and f(b, "speed") > 50.0):
        dh = math.atan2(math.sin(f(b, "heading") - f(a, "heading")),
                        math.cos(f(b, "heading") - f(a, "heading")))
        strafe_dh = max(strafe_dh, abs(dh))
if strafe_dh > 0.02:
    raise SystemExit("strafe changed heading by %.3f" % strafe_dh)

print("joystick walk=%.1f run=%.1f turn_walk=%.2f turn_run=%.2f turn_total=%.2f strafe_dh=%.4f" % (
    min(f(r, "speed") for r in walk_strafe if f(r, "speed") > 100.0),
    max(f(r, "speed") for r in run_strafe),
    walk_rate,
    run_rate,
    turn_total,
    strafe_dh,
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
    value=$(circle_max "$SHOTS/02-center.png" "$1" "$2")
    if awk -v v="$value" 'BEGIN { exit !(v < 0.55) }' >/dev/null; then
        echo "outer joystick circle missing at $1,$2: $value" >&2
        exit 1
    fi
done
for point in "718 310" "718 430"; do
    set -- $point
    value=$(circle_max "$SHOTS/02-center.png" "$1" "$2")
    if awk -v v="$value" 'BEGIN { exit !(v < 0.3) }' >/dev/null; then
        echo "inner joystick circle missing at $1,$2: $value" >&2
        exit 1
    fi
done

green_g=$(convert "$SHOTS/03-walk.png" -format '%[fx:p{740,372}.g]' info:)
green_r=$(convert "$SHOTS/03-walk.png" -format '%[fx:p{740,372}.r]' info:)
if awk -v g="$green_g" -v r="$green_r" 'BEGIN { exit !(g < 0.8 || g < r + 0.2) }' >/dev/null; then
    echo "walk speed line is not green: g=$green_g r=$green_r" >&2
    exit 1
fi
white_r=$(convert "$SHOTS/03-walk.png" -format '%[fx:p{800,372}.r]' info:)
white_g=$(convert "$SHOTS/03-walk.png" -format '%[fx:p{800,372}.g]' info:)
white_b=$(convert "$SHOTS/03-walk.png" -format '%[fx:p{800,372}.b]' info:)
if awk -v r="$white_r" -v g="$white_g" -v b="$white_b" 'BEGIN { exit !(r < 0.5 || g < 0.5 || b < 0.5) }' >/dev/null; then
    echo "white direction line missing beyond the knob" >&2
    exit 1
fi
run_green=$(convert "$SHOTS/04-run.png" -format '%[fx:p{790,372}.g]' info:)
run_red=$(convert "$SHOTS/04-run.png" -format '%[fx:p{790,372}.r]' info:)
if awk -v g="$run_green" -v r="$run_red" 'BEGIN { exit !(g < r + 0.2) }' >/dev/null; then
    echo "run speed line missing outside the inner ring" >&2
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
for shot in 01-start 03-walk 05-turn-walk 09-zoomed 11-min-zoom 12-max-zoom; do
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
start_bbox=$(map_bbox "$SHOTS/01-start.png")
walk_bbox=$(map_bbox "$SHOTS/03-walk.png")
run_bbox=$(map_bbox "$SHOTS/04-run.png")
default_w=$(map_width "$SHOTS/01-start.png")
zoom_w=$(map_width "$SHOTS/09-zoomed.png")
reset_w=$(map_width "$SHOTS/10-reset.png")
min_w=$(map_width "$SHOTS/11-min-zoom.png")
max_w=$(map_width "$SHOTS/12-max-zoom.png")
default_w=$(map_width "$SHOTS/01-start.png")
walk_w=$(map_width "$SHOTS/03-walk.png")
run_w=$(map_width "$SHOTS/04-run.png")
if [ $((walk_w - default_w)) -gt 2 ] || [ $((default_w - walk_w)) -gt 2 ] ||
   [ $((run_w - default_w)) -gt 2 ] || [ $((default_w - run_w)) -gt 2 ]; then
    echo "camera follow changed zoom while moving: $start_bbox -> $walk_bbox -> $run_bbox" >&2
    exit 1
fi
if [ "$(map_offset "$SHOTS/01-start.png")" = "$(map_offset "$SHOTS/03-walk.png")" ]; then
    echo "camera follow did not move the map after walking" >&2
    exit 1
fi
if [ "$(map_offset "$SHOTS/03-walk.png")" = "$(map_offset "$SHOTS/04-run.png")" ]; then
    echo "camera follow did not move the map after running" >&2
    exit 1
fi
if [ "$zoom_w" -le "$default_w" ]; then
    echo "zoom-in did not enlarge the map: default=$default_w zoom=$zoom_w" >&2
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

for shot in 09-zoomed 11-min-zoom 12-max-zoom; do
    for point in "718 250" "718 490" "598 370" "838 370"; do
        set -- $point
        value=$(circle_max "$SHOTS/$shot.png" "$1" "$2")
        if awk -v v="$value" 'BEGIN { exit !(v < 0.55) }' >/dev/null; then
            echo "joystick circle moved during zoom in $shot at $1,$2: $value" >&2
            exit 1
        fi
    done
done

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
