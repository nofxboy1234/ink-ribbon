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
  onCamera: (cx: number, cz: number, scale: number, vw: number, vh: number) => void;
  onPreview: (target: Target) => void;
  onCommit: (choice: PlanChoice) => void;
  onClosePreview: () => void;
};

const FLOOR_COLOUR = "rgba(148, 162, 176, 0.20)";
const CELL_EDGE = "rgba(190, 210, 230, 0.22)";
const STAIR_COLOUR = "rgba(214, 169, 92, 0.32)";
const STAIR_EDGE = "rgba(240, 196, 116, 0.72)";
const RAMP_COLOUR = "rgba(125, 211, 252, 0.28)";
const RAMP_EDGE = "rgba(125, 211, 252, 0.8)";
const TEXT = "rgba(221, 234, 247, 0.9)";
const MUTED = "rgba(157, 181, 205, 0.7)";
const ROUTE = "#43ff74";
const PREVIEW = "#ff9d3c";
const WAYPOINT = "rgba(34, 211, 238, 0.4)";
const WAYPOINT_EDGE = "rgba(34, 211, 238, 0.95)";
const PLAYER = "#c28cff";
const DOOR_SIZE = 5;

function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
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
  onCamera,
  onPreview,
  onCommit,
  onClosePreview,
}: FloorMap2DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
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

  const emitCamera = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const camera = cameraRef.current;
    onCamera(camera.cx, camera.cz, camera.scale, rect.width, rect.height);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const fit = () => {
      const rect = canvas.getBoundingClientRect();
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
      emitCamera();
      setCameraVersion((value) => value + 1);
    };
    fit();
  }, [floor, mapBounds, onCamera]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(rect.width * dpr)) {
        canvas.width = Math.round(rect.width * dpr);
      }
      if (canvas.height !== Math.round(rect.height * dpr)) {
        canvas.height = Math.round(rect.height * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const camera = cameraRef.current;
      const { cx, cz, scale } = camera;
      const px = (x: number) => (x - cx) * scale + rect.width / 2;
      const pz = (z: number) => (z - cz) * scale + rect.height / 2;
      const nodes: number[] = [];
      for (let i = 0; i < nav.count; i++) {
        if (nav.floor[i] !== floor) continue;
        nodes.push(i);
      }

      const floorLevel = quest.floors[floor]?.level ?? 0;
      const floorLabel = quest.floors[floor]?.label ?? `${floor + 1}F`;
      const floorItems = quest.items.filter(
        (item) => Math.abs(item.y - floorLevel - 0.36) < 0.8,
      );
      const floorDoors = quest.doors.filter(
        (door) => Math.abs(door.y - floorLevel) < 2.5,
      );
      ctx.fillStyle = TEXT;
      ctx.font = "600 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(`${floorLabel} · SOKOL TOP-DOWN`, 42, 146);
      ctx.fillStyle = MUTED;
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ctx.fillText(
        `${nodes.length} cells · ${floorItems.length} items · ${floorDoors.length} doors · wheel to zoom · drag to pan`,
        42,
        162,
      );

      ctx.save();
      ctx.beginPath();
      ctx.rect(34, 166, rect.width - 34, rect.height - 166);
      ctx.clip();

      for (const node of nodes) {
        const x = px(nav.x[node]) - scale / 2;
        const y = pz(nav.z[node]) - scale / 2;
        const kind = nav.kind[node];
        ctx.fillStyle = kind === 1 ? STAIR_COLOUR : kind === 2 ? RAMP_COLOUR : FLOOR_COLOUR;
        ctx.strokeStyle = kind === 1 ? STAIR_EDGE : kind === 2 ? RAMP_EDGE : CELL_EDGE;
        ctx.lineWidth = 0.6;
        ctx.fillRect(x, y, Math.max(1.5, scale - 0.7), Math.max(1.5, scale - 0.7));
        ctx.strokeRect(x, y, Math.max(1.5, scale - 0.7), Math.max(1.5, scale - 0.7));
      }

      const pathPoints: Vec3[] = planPath.filter(
        (point) => Math.abs(point[1] - floorLevel) < 2.5,
      );
      if (pathPoints.length > 1) {
        ctx.strokeStyle = "rgba(67, 255, 116, 0.28)";
        ctx.lineWidth = Math.max(5, scale * 0.7);
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(px(pathPoints[0][0]), pz(pathPoints[0][2]));
        for (const point of pathPoints.slice(1)) ctx.lineTo(px(point[0]), pz(point[2]));
        ctx.stroke();
        ctx.strokeStyle = ROUTE;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(px(pathPoints[0][0]), pz(pathPoints[0][2]));
        for (const point of pathPoints.slice(1)) ctx.lineTo(px(point[0]), pz(point[2]));
        ctx.stroke();
      }

      if (preview) {
        const points = preview.points.filter(
          (point) => Math.abs(point[1] - floorLevel) < 2.5,
        );
        if (points.length > 1) {
          ctx.strokeStyle = PREVIEW;
          ctx.lineWidth = 1.8;
          ctx.setLineDash([5, 5]);
          ctx.beginPath();
          ctx.moveTo(px(points[0][0]), pz(points[0][2]));
          for (const point of points.slice(1)) ctx.lineTo(px(point[0]), pz(point[2]));
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      for (const step of plan) {
        const node = step.type === "move" ? step.endNode : step.node;
        if (node < 0 || node >= nav.count || nav.floor[node] !== floor) continue;
        const x = px(nav.x[node]) - scale / 2;
        const y = pz(nav.z[node]) - scale / 2;
        ctx.fillStyle = WAYPOINT;
        ctx.fillRect(x, y, scale, scale);
        ctx.strokeStyle = WAYPOINT_EDGE;
        ctx.lineWidth = 1.4;
        ctx.strokeRect(x + 0.5, y + 0.5, scale - 1, scale - 1);
      }

      for (const door of floorDoors) {
        const colour = DOOR_COLOURS[doorStates.get(door.id) ?? door.state];
        ctx.fillStyle = `rgb(${colour[0]}, ${colour[1]}, ${colour[2]})`;
        ctx.fillRect(
          px(door.x) - DOOR_SIZE / 2,
          pz(door.z) - DOOR_SIZE / 2,
          DOOR_SIZE,
          DOOR_SIZE,
        );
      }

      for (const item of floorItems) {
        if (!discovered.has(item.id)) continue;
        const x = px(item.x);
        const y = pz(item.z);
        ctx.fillStyle = item.color;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
        ctx.lineWidth = 1.5;
        if (item.shape === "sphere" || item.shape === "cylinder") {
          ctx.beginPath();
          ctx.arc(x, y, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else if (item.shape === "cube") {
          ctx.fillRect(x - 4, y - 4, 8, 8);
          ctx.strokeRect(x - 4, y - 4, 8, 8);
        } else {
          drawDiamond(ctx, x, y, 5);
          ctx.fill();
          ctx.stroke();
        }
      }

      if (Math.abs(player[1] - floorLevel - 0.9) < 2.2) {
        const x = px(player[0]);
        const y = pz(player[2]);
        ctx.fillStyle = "rgba(194, 140, 255, 0.16)";
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = PLAYER;
        ctx.strokeStyle = "rgba(236, 221, 255, 0.95)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = TEXT;
        ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        ctx.fillText("CLAIRE", x + 10, y + 3);
      }

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const room of quest.rooms) {
        if (room.floor !== floor) continue;
        const x = px(room.x);
        const y = pz(room.z);
        if (x < 34 || x > rect.width || y < 160 || y > rect.height) continue;
        ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        const width = ctx.measureText(room.name).width;
        ctx.fillStyle = "rgba(4, 7, 10, 0.72)";
        ctx.fillRect(x - width / 2 - 3, y - 7, width + 6, 12);
        ctx.fillStyle = "rgba(219, 232, 245, 0.8)";
        ctx.fillText(room.name, x, y);
      }
      ctx.restore();

      const legendY = rect.height - 24;
      const legend: [string, string][] = [
        [PLAYER, "CLAIRE"],
        [ROUTE, "ROUTE"],
        [PREVIEW, "PREVIEW"],
        ["#2dd4bf", "WAYPOINT"],
        ["#1f77b4", "DOOR"],
        ["#43d17a", "ITEM"],
        ["#d6a95c", "STAIR"],
      ];
      let legendX = 42;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      for (const [colour, label] of legend) {
        ctx.fillStyle = colour;
        ctx.fillRect(legendX, legendY - 4, 8, 8);
        ctx.fillStyle = MUTED;
        ctx.fillText(label, legendX + 13, legendY);
        legendX += 13 + ctx.measureText(label).width + 18;
      }
      if (Math.abs(player[1] - floorLevel - 0.9) >= 2.2) {
        ctx.fillStyle = MUTED;
        ctx.fillText("Claire is on another floor", 42, rect.height - 44);
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    window.addEventListener("resize", draw);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", draw);
    };
  }, [nav, quest, floor, player, discovered, doorStates, plan, planPath, preview]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
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
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(event.pointerId);
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

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas || drag.id !== event.pointerId) return;
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

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    dragRef.current = null;
    if (!drag || !canvas || drag.id !== event.pointerId) return;
    if (event.type === "pointercancel" || drag.moved > 4) return;
    const rect = canvas.getBoundingClientRect();
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
    if (nearest >= 0 && best <= nav.step * 0.85) {
      onPreview({ kind: "cell", node: nearest });
    }
  };

  const previewAnchor = (() => {
    const canvas = canvasRef.current;
    if (!canvas || !preview) return null;
    const rect = canvas.getBoundingClientRect();
    const camera = cameraRef.current;
    return {
      x: (preview.anchor[0] - camera.cx) * camera.scale + rect.width / 2,
      y: (preview.anchor[2] - camera.cz) * camera.scale + rect.height / 2,
    };
  })();

  return (
    <>
      <canvas
        ref={canvasRef}
        className="rpd-map"
        aria-label="Top-down RPD floor plan"
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
    </>
  );
}
