import { useEffect, useRef, useState } from "react";
import type { NavGraph } from "./nav";
import { DOOR_COLOURS, type DoorState, type Quest, type Vec3 } from "./quest";
import type { PlanChoice, PlanStep, Preview, Target } from "./planner";

type MapCamera = { cx: number; cz: number; scale: number };

type FloorMap2DProps = {
  nav: NavGraph;
  quest: Quest;
  floor: number;
  player: Vec3;
  discovered: Set<string>;
  doorStates: Map<string, DoorState>;
  plan: PlanStep[];
  planPath: Vec3[];
  mapBounds: [number, number, number, number];
  preview: Preview | null;
  onMapData: (vertices: Float32Array) => void;
  onCamera: (cx: number, cz: number, scale: number, vw: number, vh: number) => void;
  onPreview: (target: Target) => void;
  onCommit: (choice: PlanChoice) => void;
  onClosePreview: () => void;
};

type RGBA = [number, number, number, number];

const FLOOR: RGBA = [0.24, 0.29, 0.35, 0.42];
const STAIR: RGBA = [0.78, 0.59, 0.28, 0.46];
const RAMP: RGBA = [0.35, 0.69, 0.85, 0.42];
const WALL: RGBA = [0.67, 0.73, 0.81, 0.95];
const WALL_CORE: RGBA = [0.09, 0.12, 0.16, 0.95];
const ROUTE: RGBA = [0.26, 1.0, 0.45, 0.95];
const PREVIEW: RGBA = [1.0, 0.62, 0.24, 0.9];
const WAYPOINT: RGBA = [0.13, 0.83, 0.93, 0.42];
const DOOR: RGBA = [0.12, 0.47, 0.71, 1.0];
const PLAYER: RGBA = [0.76, 0.55, 1.0, 1.0];

function pushQuad(
  out: number[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
  colour: RGBA,
) {
  const [r, g, b, a] = colour;
  out.push(
    ax, az, r, g, b, a,
    bx, bz, r, g, b, a,
    cx, cz, r, g, b, a,
    ax, az, r, g, b, a,
    cx, cz, r, g, b, a,
    dx, dz, r, g, b, a,
  );
}

function pushRect(out: number[], x: number, z: number, w: number, h: number, colour: RGBA) {
  pushQuad(out, x - w / 2, z - h / 2, x + w / 2, z - h / 2, x + w / 2, z + h / 2, x - w / 2, z + h / 2, colour);
}

function pushSegment(out: number[], ax: number, az: number, bx: number, bz: number, width: number, colour: RGBA) {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < 1e-5) return;
  const nx = (-dz / len) * width * 0.5;
  const nz = (dx / len) * width * 0.5;
  pushQuad(out, ax + nx, az + nz, bx + nx, bz + nz, bx - nx, bz - nz, ax - nx, az - nz, colour);
}

function pushDisc(out: number[], x: number, z: number, r: number, colour: RGBA, segments = 14) {
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const [cr, cg, cb, ca] = colour;
    out.push(
      x, z, cr, cg, cb, ca,
      x + Math.cos(a0) * r, z + Math.sin(a0) * r, cr, cg, cb, ca,
      x + Math.cos(a1) * r, z + Math.sin(a1) * r, cr, cg, cb, ca,
    );
  }
}

export default function FloorMap2D({
  nav,
  quest,
  floor,
  player,
  discovered,
  doorStates,
  plan,
  planPath,
  mapBounds,
  preview,
  onMapData,
  onCamera,
  onPreview,
  onCommit,
  onClosePreview,
}: FloorMap2DProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<MapCamera>({ cx: 0, cz: 0, scale: 8 });
  const [, setCameraVersion] = useState(0);
  const dragRef = useRef<{
    id: number;
    x: number;
    y: number;
    cx: number;
    cz: number;
    moved: number;
  } | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  const emitCamera = () => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const camera = cameraRef.current;
    onCamera(camera.cx, camera.cz, camera.scale, rect.width, rect.height);
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const fit = () => {
      const rect = root.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const rightInset = Math.min(430, Math.max(380, rect.width * 0.31));
      const left = 42;
      const top = 158;
      const plotW = Math.max(120, rect.width - rightInset - left - 24);
      const plotH = Math.max(120, rect.height - top - 54);
      const spanX = Math.max(1, mapBounds[2] - mapBounds[0]);
      const spanZ = Math.max(1, mapBounds[3] - mapBounds[1]);
      const scale = Math.max(1, Math.min(plotW / spanX, plotH / spanZ));
      cameraRef.current = {
        cx: (mapBounds[0] + mapBounds[2]) / 2,
        cz: (mapBounds[1] + mapBounds[3]) / 2,
        scale,
      };
      setViewport({ width: rect.width, height: rect.height });
      emitCamera();
      setCameraVersion((value) => value + 1);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(root);
    return () => observer.disconnect();
  }, [floor, mapBounds, onCamera]);

  useEffect(() => {
    const out: number[] = [];
    const active: number[] = [];
    const key = new Map<string, number>();
    for (let i = 0; i < nav.count; i++) {
      if (nav.floor[i] !== floor) continue;
      active.push(i);
      key.set(`${nav.x[i].toFixed(2)},${nav.z[i].toFixed(2)}`, i);
    }
    const half = nav.half;
    const step = nav.step;
    const has = (x: number, z: number) => key.has(`${x.toFixed(2)},${z.toFixed(2)}`);

    for (const node of active) {
      const x = nav.x[node];
      const z = nav.z[node];
      const colour = nav.kind[node] === 1 ? STAIR : nav.kind[node] === 2 ? RAMP : FLOOR;
      pushRect(out, x, z, step, step, colour);
    }

    for (const node of active) {
      const x = nav.x[node];
      const z = nav.z[node];
      pushRect(out, x, z, step, step, [WALL_CORE[0], WALL_CORE[1], WALL_CORE[2], 0.22]);
      if (!has(x, z - step)) pushRect(out, x, z - half, step, 0.09, WALL);
      if (!has(x, z + step)) pushRect(out, x, z + half, step, 0.09, WALL);
      if (!has(x - step, z)) pushRect(out, x - half, z, 0.09, step, WALL);
      if (!has(x + step, z)) pushRect(out, x + half, z, 0.09, step, WALL);
    }

    const floorPoints = planPath.filter((point) => Math.abs(point[1] - (quest.floors[floor]?.level ?? 0)) < 2.5);
    for (let i = 1; i < floorPoints.length; i++) {
      pushSegment(out, floorPoints[i - 1][0], floorPoints[i - 1][2], floorPoints[i][0], floorPoints[i][2], 0.22, ROUTE);
    }

    if (preview) {
      const previewPoints = preview.points.filter(
        (point) => Math.abs(point[1] - (quest.floors[floor]?.level ?? 0)) < 2.5,
      );
      for (let i = 1; i < previewPoints.length; i++) {
        pushSegment(
          out,
          previewPoints[i - 1][0],
          previewPoints[i - 1][2],
          previewPoints[i][0],
          previewPoints[i][2],
          0.18,
          PREVIEW,
        );
      }
    }

    for (const step of plan) {
      const node = step.type === "move" ? step.endNode : step.node;
      if (node < 0 || node >= nav.count || nav.floor[node] !== floor) continue;
      pushRect(out, nav.x[node], nav.z[node], stepWidth(nav), stepWidth(nav), WAYPOINT);
    }

    const floorLevel = quest.floors[floor]?.level ?? 0;
    for (const door of quest.doors) {
      if (Math.abs(door.y - floorLevel) >= 2.5) continue;
      const rgb = DOOR_COLOURS[doorStates.get(door.id) ?? door.state];
      pushRect(out, door.x, door.z, 0.22, 0.22, [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1]);
    }

    for (const item of quest.items) {
      if (!discovered.has(item.id)) continue;
      if (Math.abs(item.y - floorLevel - 0.36) >= 0.8) continue;
      const rgb = item.rgb;
      pushDisc(out, item.x, item.z, 0.2, [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1]);
    }

    if (Math.abs(player[1] - floorLevel - 0.9) < 2.2) {
      pushDisc(out, player[0], player[2], 0.44, [PLAYER[0], PLAYER[1], PLAYER[2], 0.16], 18);
      pushDisc(out, player[0], player[2], 0.15, PLAYER, 14);
    }

    onMapData(new Float32Array(out));
  }, [nav, quest, floor, player, discovered, doorStates, plan, planPath, preview, onMapData]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = root.getBoundingClientRect();
      const mx = event.clientX - rect.left - rect.width / 2;
      const my = event.clientY - rect.top - rect.height / 2;
      const camera = cameraRef.current;
      const worldX = camera.cx + mx / camera.scale;
      const worldZ = camera.cz + my / camera.scale;
      const next = Math.min(42, Math.max(2.5, camera.scale * (event.deltaY > 0 ? 0.88 : 1.14)));
      cameraRef.current = { cx: worldX - mx / next, cz: worldZ - my / next, scale: next };
      emitCamera();
      setCameraVersion((value) => value + 1);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!rootRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const camera = cameraRef.current;
    dragRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      cx: camera.cx,
      cz: camera.cz,
      moved: 0,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const root = rootRef.current;
    if (!drag || !root || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
    const camera = cameraRef.current;
    cameraRef.current = {
      cx: drag.cx - dx / camera.scale,
      cz: drag.cz - dy / camera.scale,
      scale: camera.scale,
    };
    emitCamera();
    setCameraVersion((value) => value + 1);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const root = rootRef.current;
    dragRef.current = null;
    if (!drag || !root || drag.id !== event.pointerId) return;
    if (event.type === "pointercancel" || drag.moved > 4) return;
    const rect = root.getBoundingClientRect();
    const camera = cameraRef.current;
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const wx = camera.cx + (sx - rect.width / 2) / camera.scale;
    const wz = camera.cz + (sy - rect.height / 2) / camera.scale;
    const floorLevel = quest.floors[floor]?.level ?? 0;

    const screenDistance = (x: number, z: number) =>
      Math.hypot(
        (x - camera.cx) * camera.scale - (sx - rect.width / 2),
        (z - camera.cz) * camera.scale - (sy - rect.height / 2),
      );

    const hitItem = quest.items
      .filter(
        (item) =>
          discovered.has(item.id) &&
          !plan.some((step) => step.type === "pickup" && step.itemId === item.id) &&
          Math.abs(item.y - floorLevel - 0.36) < 0.8,
      )
      .map((item) => ({ item, distance: screenDistance(item.x, item.z) }))
      .filter((entry) => entry.distance < 11)
      .sort((a, b) => a.distance - b.distance)[0];
    if (hitItem) {
      onPreview({ kind: "item", id: hitItem.item.id });
      return;
    }

    const hitDoor = quest.doors
      .filter((door) => Math.abs(door.y - floorLevel) < 2.5)
      .map((door) => ({ door, distance: screenDistance(door.x, door.z) }))
      .filter((entry) => entry.distance < 10)
      .sort((a, b) => a.distance - b.distance)[0];
    if (hitDoor) {
      onPreview({ kind: "door", id: hitDoor.door.id });
      return;
    }

    let nearest = -1;
    let best = Infinity;
    for (let i = 0; i < nav.count; i++) {
      if (nav.floor[i] !== floor) continue;
      const distance = Math.hypot(nav.x[i] - wx, nav.z[i] - wz);
      if (distance < best) {
        best = distance;
        nearest = i;
      }
    }
    if (nearest >= 0 && best <= nav.step * 2.5) {
      onPreview({ kind: "cell", node: nearest });
    }
  };

  const camera = cameraRef.current;
  const floorLevel = quest.floors[floor]?.level ?? 0;
  const floorLabel = quest.floors[floor]?.label ?? `${floor + 1}F`;
  const floorItems = quest.items.filter((item) => Math.abs(item.y - floorLevel - 0.36) < 0.8);
  const floorDoors = quest.doors.filter((door) => Math.abs(door.y - floorLevel) < 2.5);
  const rooms = quest.rooms.filter((room) => room.floor === floor);
  let activeCount = 0;
  for (let i = 0; i < nav.count; i++) if (nav.floor[i] === floor) activeCount += 1;

  const previewAnchor = preview
    ? {
        x: (preview.anchor[0] - camera.cx) * camera.scale + viewport.width / 2,
        y: (preview.anchor[2] - camera.cz) * camera.scale + viewport.height / 2,
      }
    : null;

  return (
    <div className="rpd-map" ref={rootRef}>
      <div className="rpd-map-labels" aria-hidden="true">
        <div className="rpd-map-title">
          <strong>{floorLabel} · SOKOL TOP-DOWN</strong>
          <span>
            {activeCount} cells · {floorItems.length} items · {floorDoors.length} doors · wheel to zoom · drag to pan
          </span>
        </div>
        {rooms.map((room) => (
          <span
            key={room.name}
            className="rpd-map-room"
            style={{
              left: (room.x - camera.cx) * camera.scale + viewport.width / 2,
              top: (room.z - camera.cz) * camera.scale + viewport.height / 2,
            }}
          >
            {room.name}
          </span>
        ))}
        {Math.abs(player[1] - floorLevel - 0.9) < 2.2 && (
          <span
            className="rpd-map-player"
            style={{
              left: (player[0] - camera.cx) * camera.scale + viewport.width / 2,
              top: (player[2] - camera.cz) * camera.scale + viewport.height / 2,
            }}
          >
            CLAIRE
          </span>
        )}
        <div className="rpd-map-legend">
          <span><i style={{ background: "#c28cff" }} />CLAIRE</span>
          <span><i style={{ background: "#43ff74" }} />ROUTE</span>
          <span><i style={{ background: "#ff9d3c" }} />PREVIEW</span>
          <span><i style={{ background: "#22d3ee" }} />WAYPOINT</span>
          <span><i style={{ background: "#1f77b4" }} />DOOR</span>
          <span><i style={{ background: "#43d17a" }} />ITEM</span>
          <span><i style={{ background: "#d6a95c" }} />STAIR</span>
        </div>
        {Math.abs(player[1] - floorLevel - 0.9) >= 2.2 && (
          <div className="rpd-map-note">Claire is on another floor</div>
        )}
      </div>
      <div
        className="rpd-map-hit"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(event) => event.preventDefault()}
      />
      {preview && previewAnchor && (
        <div
          className="rpd-map-actions"
          style={{ left: previewAnchor.x + 14, top: previewAnchor.y + 14 }}
        >
          <header>
            <strong>{preview.label}</strong>
            <button type="button" onClick={onClosePreview} aria-label="Close map actions">
              ×
            </button>
          </header>
          {preview.choices.map((choice, index) => (
            <button
              key={`${choice.kind}-${choice.label}-${index}`}
              type="button"
              className="rpd-map-choice"
              data-kind={choice.kind}
              disabled={choice.kind === "info"}
              onClick={() => onCommit(choice)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function stepWidth(nav: NavGraph) {
  return nav.step;
}
