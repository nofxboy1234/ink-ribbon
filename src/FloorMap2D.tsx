import { useEffect, useRef } from "react";
import type { NavGraph } from "./nav";
import { DOOR_COLOURS, type DoorState, type Quest, type Vec3 } from "./quest";
import type { PlanStep } from "./planner";

type FloorMap2DProps = {
  nav: NavGraph;
  quest: Quest;
  floor: number;
  player: Vec3;
  discovered: Set<string>;
  doorStates: Map<string, DoorState>;
  plan: PlanStep[];
  planPath: Vec3[];
};

const CELL = "rgba(154, 168, 182, 0.22)";
const CELL_EDGE = "rgba(188, 208, 228, 0.16)";
const TEXT = "rgba(221, 234, 247, 0.88)";
const MUTED = "rgba(157, 181, 205, 0.62)";
const ROUTE = "#43ff74";
const WAYPOINT = "rgba(34, 211, 238, 0.38)";
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
}: FloorMap2DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.fillStyle = "#07090c";
      ctx.fillRect(0, 0, rect.width, rect.height);

      const floorLevel = quest.floors[floor]?.level ?? 0;
      const floorLabel = quest.floors[floor]?.label ?? `${floor + 1}F`;
      const nodes: number[] = [];
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < nav.count; i++) {
        if (nav.floor[i] !== floor) continue;
        nodes.push(i);
        minX = Math.min(minX, nav.x[i]);
        maxX = Math.max(maxX, nav.x[i]);
        minZ = Math.min(minZ, nav.z[i]);
        maxZ = Math.max(maxZ, nav.z[i]);
      }
      if (nodes.length === 0) return;

      const rightInset = Math.min(430, Math.max(380, rect.width * 0.31));
      const left = 42;
      const top = 172;
      const plotW = Math.max(120, rect.width - rightInset - left - 24);
      const plotH = Math.max(120, rect.height - top - 54);
      const spanX = maxX - minX + 2;
      const spanZ = maxZ - minZ + 2;
      const scale = Math.max(1, Math.min(plotW / spanX, plotH / spanZ));
      const originX = left + (plotW - spanX * scale) / 2 - (minX - 1) * scale;
      const originY = top + (plotH - spanZ * scale) / 2 - (minZ - 1) * scale;
      const px = (x: number) => originX + x * scale;
      const pz = (z: number) => originY + z * scale;
      const cell = Math.max(1.5, scale - 0.7);

      ctx.fillStyle = TEXT;
      ctx.font = "600 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(`${floorLabel} · TOP-DOWN`, left, 146);
      ctx.fillStyle = MUTED;
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      const floorItems = quest.items.filter(
        (item) => Math.abs(item.y - floorLevel - 0.36) < 0.8,
      );
      ctx.fillText(
        `${nodes.length} walkable cells · ${floorItems.length} items · ${quest.doors.filter(
          (door) => Math.abs(door.y - floorLevel) < 2.5,
        ).length} doors`,
        left,
        162,
      );


      ctx.save();
      ctx.beginPath();
      ctx.rect(left - 8, top - 8, plotW + 16, plotH + 16);
      ctx.clip();

      ctx.fillStyle = CELL;
      ctx.strokeStyle = CELL_EDGE;
      ctx.lineWidth = 0.6;
      for (const node of nodes) {
        const x = px(nav.x[node]) - scale / 2;
        const y = pz(nav.z[node]) - scale / 2;
        ctx.fillRect(x, y, cell, cell);
        ctx.strokeRect(x, y, cell, cell);
      }

      const pathNodes: Vec3[] = planPath.filter(
        (point) => Math.abs(point[1] - floorLevel) < 2.5,
      );
      if (pathNodes.length > 1) {
        ctx.strokeStyle = "rgba(67, 255, 116, 0.28)";
        ctx.lineWidth = 7;
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(px(pathNodes[0][0]), pz(pathNodes[0][2]));
        for (const point of pathNodes.slice(1)) ctx.lineTo(px(point[0]), pz(point[2]));
        ctx.stroke();
        ctx.strokeStyle = ROUTE;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(px(pathNodes[0][0]), pz(pathNodes[0][2]));
        for (const point of pathNodes.slice(1)) ctx.lineTo(px(point[0]), pz(point[2]));
        ctx.stroke();
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


      for (const door of quest.doors) {
        if (Math.abs(door.y - floorLevel) >= 2.5) continue;
        const colour = DOOR_COLOURS[doorStates.get(door.id) ?? door.state];
        ctx.fillStyle = `rgb(${colour[0]}, ${colour[1]}, ${colour[2]})`;
        ctx.fillRect(
          px(door.x) - DOOR_SIZE / 2,
          pz(door.z) - DOOR_SIZE / 2,
          DOOR_SIZE,
          DOOR_SIZE,
        );
      }

      for (const item of quest.items) {
        if (!discovered.has(item.id)) continue;
        if (Math.abs(item.y - floorLevel - 0.36) >= 0.8) continue;
        const x = px(item.x);
        const y = pz(item.z);
        ctx.fillStyle = item.color;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.65)";
        ctx.lineWidth = 1.5;
        if (item.shape === "sphere") {
          ctx.beginPath();
          ctx.arc(x, y, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else if (item.shape === "cube") {
          ctx.fillRect(x - 4, y - 4, 8, 8);
          ctx.strokeRect(x - 4, y - 4, 8, 8);
        } else if (item.shape === "pyramid") {
          drawDiamond(ctx, x, y, 5);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
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
      } else {
        ctx.fillStyle = MUTED;
        ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        ctx.fillText("Claire is on another floor", left, rect.height - 48);
      }

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const room of quest.rooms) {
        if (room.floor !== floor) continue;
        const x = px(room.x);
        const y = pz(room.z);
        if (x < left - 4 || x > left + plotW + 4 || y < top - 4 || y > top + plotH + 4) continue;
        ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        const width = ctx.measureText(room.name).width;
        ctx.fillStyle = "rgba(4, 7, 10, 0.62)";
        ctx.fillRect(x - width / 2 - 3, y - 7, width + 6, 12);
        ctx.fillStyle = "rgba(219, 232, 245, 0.76)";
        ctx.fillText(room.name, x, y);
      }
      ctx.restore();

      const legendY = rect.height - 24;
      const legend: [string, string][] = [
        [PLAYER, "CLAIRE"],
        [ROUTE, "ROUTE"],
        ["#2dd4bf", "WAYPOINT"],
        ["#1f77b4", "DOOR"],
        ["#43d17a", "ITEM"],
      ];
      let legendX = left;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      for (const [colour, label] of legend) {
        ctx.fillStyle = colour;
        ctx.fillRect(legendX, legendY - 4, 8, 8);
        ctx.fillStyle = MUTED;
        ctx.fillText(label, legendX + 13, legendY);
        legendX += 13 + ctx.measureText(label).width + 22;
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
  }, [nav, quest, floor, player, discovered, doorStates, plan, planPath]);

  return (
    <canvas
      ref={canvasRef}
      className="rpd-map"
      aria-label="Top-down RPD floor plan"
    />
  );
}
