import { useEffect, useRef, useState } from "react";
import type { NavGraph } from "./nav";
import { DOOR_COLOURS, type DoorState, type Quest, type Vec3 } from "./quest";
import type { PlanStep, Preview, Target } from "./planner";

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
  onCamera: (
    cx: number,
    cz: number,
    scale: number,
    vw: number,
    vh: number,
    floorY: number,
  ) => void;
  focusToken: number;
  onPreview: (target: Target) => void;
  onPreviewAnchor: (anchor: { x: number; y: number } | null) => void;
};

type RGBA = [number, number, number, number];

const FLOOR: RGBA = [0.38, 0.48, 0.6, 0.1];
const STAIR: RGBA = [0.78, 0.59, 0.28, 0.26];
const RAMP: RGBA = [0.35, 0.69, 0.85, 0.26];
const NAV_BORDER: RGBA = [0.37, 0.65, 0.9, 0.5];
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
  focusToken,
  onPreview,
  onPreviewAnchor,
}: FloorMap2DProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<MapCamera>({ cx: 0, cz: 0, scale: 8 });
  const [cameraVersion, setCameraVersion] = useState(0);
  const focusAnimRef = useRef(0);
  const dragRef = useRef<{
    id: number;
    button: number;
    x: number;
    y: number;
    cx: number;
    cz: number;
    moved: number;
  } | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [hoverNode, setHoverNode] = useState<number | null>(null);

  const emitCamera = () => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const camera = cameraRef.current;
    onCamera(
      camera.cx,
      camera.cz,
      camera.scale,
      rect.width,
      rect.height,
      quest.floors[floor]?.level ?? 0,
    );
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
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
  }, [floor, mapBounds, onCamera]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => {
      const rect = root.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      setViewport({ width: rect.width, height: rect.height });
      emitCamera();
      setCameraVersion((value) => value + 1);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [floor, onCamera]);

  useEffect(() => {
    if (focusToken === 0) return;
    const from = { ...cameraRef.current };
    const started = performance.now();
    const duration = 420;
    const animate = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      cameraRef.current = {
        cx: from.cx + (player[0] - from.cx) * ease,
        cz: from.cz + (player[2] - from.cz) * ease,
        scale: from.scale,
      };
      emitCamera();
      setCameraVersion((value) => value + 1);
      if (t < 1) focusAnimRef.current = requestAnimationFrame(animate);
    };
    focusAnimRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(focusAnimRef.current);
  }, [focusToken]);

  useEffect(() => {
    const out: number[] = [];
    const active: number[] = [];
    for (let i = 0; i < nav.count; i++) {
      if (nav.floor[i] !== floor) continue;
      active.push(i);
    }
    const half = nav.half;
    const step = nav.step;

    for (const node of active) {
      const x = nav.x[node];
      const z = nav.z[node];
      const colour = nav.kind[node] === 1 ? STAIR : nav.kind[node] === 2 ? RAMP : FLOOR;
      pushRect(out, x, z, step, step, colour);
      const edge = Math.max(0.035, step * 0.035);
      pushRect(out, x, z - half, step, edge, NAV_BORDER);
      pushRect(out, x, z + half, step, edge, NAV_BORDER);
      pushRect(out, x - half, z, edge, step, NAV_BORDER);
      pushRect(out, x + half, z, edge, step, NAV_BORDER);
    }

    if (hoverNode !== null && hoverNode >= 0 && hoverNode < nav.count && nav.floor[hoverNode] === floor) {
      const x = nav.x[hoverNode];
      const z = nav.z[hoverNode];
      pushRect(out, x, z, step, step, [0.22, 1.0, 0.08, 0.3]);
      const edge = Math.max(0.04, step * 0.04);
      pushRect(out, x, z - half, step, edge, [0.22, 1.0, 0.08, 0.95]);
      pushRect(out, x, z + half, step, edge, [0.22, 1.0, 0.08, 0.95]);
      pushRect(out, x - half, z, edge, step, [0.22, 1.0, 0.08, 0.95]);
      pushRect(out, x + half, z, edge, step, [0.22, 1.0, 0.08, 0.95]);
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

    onMapData(new Float32Array(out));
  }, [nav, quest, floor, discovered, doorStates, plan, planPath, preview, hoverNode, onMapData]);

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
    if (event.button !== 0 && event.button !== 1) return;
    cancelAnimationFrame(focusAnimRef.current);
    event.preventDefault();
    if (!rootRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const camera = cameraRef.current;
    dragRef.current = {
      id: event.pointerId,
      button: event.button,
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
    if (!root) return;
    if (!drag) {
      const rect = root.getBoundingClientRect();
      const camera = cameraRef.current;
      const wx = camera.cx + (event.clientX - rect.left - rect.width / 2) / camera.scale;
      const wz = camera.cz + (event.clientY - rect.top - rect.height / 2) / camera.scale;
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
      setHoverNode(nearest >= 0 && best <= nav.step * 0.85 ? nearest : null);
      return;
    }
    if (drag.id !== event.pointerId) return;
    const mask = drag.button === 1 ? 4 : drag.button === 0 ? 1 : 2;
    if ((event.buttons & mask) === 0) {
      dragRef.current = null;
      return;
    }
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
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
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
  const playerOnFloor = Math.abs(player[1] - floorLevel - 0.9) < 2.2;
  const playerScreenX = (player[0] - camera.cx) * camera.scale + viewport.width / 2;
  const playerScreenY = (player[2] - camera.cz) * camera.scale + viewport.height / 2;
  const rooms = quest.rooms.filter((room) => {
    if (room.floor !== floor) return false;
    if (!playerOnFloor) return true;
    const x = (room.x - camera.cx) * camera.scale + viewport.width / 2;
    const y = (room.z - camera.cz) * camera.scale + viewport.height / 2;
    return Math.hypot(x - playerScreenX, y - playerScreenY) > 36;
  });
  let activeCount = 0;
  for (let i = 0; i < nav.count; i++) if (nav.floor[i] === floor) activeCount += 1;

  useEffect(() => {
    const root = rootRef.current;
    if (!preview || !root) {
      onPreviewAnchor(null);
      return;
    }
    const rect = root.getBoundingClientRect();
    const cam = cameraRef.current;
    onPreviewAnchor({
      x: (preview.anchor[0] - cam.cx) * cam.scale + rect.width / 2,
      y: (preview.anchor[2] - cam.cz) * cam.scale + rect.height / 2,
    });
  }, [preview, cameraVersion, viewport, onPreviewAnchor]);

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
        onPointerLeave={() => setHoverNode(null)}
        onLostPointerCapture={() => {
          dragRef.current = null;
        }}
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
        onAuxClick={(event) => event.preventDefault()}
        onContextMenu={(event) => event.preventDefault()}
      />

    </div>
  );
}

function stepWidth(nav: NavGraph) {
  return nav.step;
}
