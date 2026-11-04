import type { NavGraph } from "../nav";
import { nearestNode } from "../nav";
import { nearbyRoom } from "../quest";
import type { Door, Quest, Vec3 } from "../quest";
import type { PlanStep, Preview } from "../planner";
import { popupGeometry, projectPoint } from "./geometry";
import { NAV_CELL_CENTRE, NAV_CELL_OTHER, NAV_CELL_SIDE } from "../nav/style";

type GridLines = Map<number, [Vec3, Vec3][]>;

type SceneOverlayInput = {
  canvas: HTMLCanvasElement;
  viewProj: Float32Array;
  quest: Quest;
  nav: NavGraph;
  activeFloor: number;
  doors: readonly Door[];
  gridLines: GridLines;
  navNodesByFloor: number[][];
  player: Vec3;
  hovered: number | null;
  plan: readonly PlanStep[];
  planPath: Vec3[];
  preview: Preview | null;
  planCursor: Vec3 | null;
  view2D: boolean;
  popupLayer: HTMLElement | null;
};

export function drawSceneOverlay(input: SceneOverlayInput) {
  const {
    canvas,
    viewProj,
    quest,
    nav,
    activeFloor,
    doors,
    gridLines,
    navNodesByFloor,
    player,
    plan,
    planPath,
    preview,
    planCursor,
    view2D,
    popupLayer,
  } = input;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const matrix = viewProj;

      const hovered = input.hovered;

      const cellQuad = (node: number): { x: number; y: number }[] | null => {
        const x = nav.x[node];
        const y = nav.y[node] + 0.02;
        const z = nav.z[node];
        const half = nav.half;
        const corners: { x: number; y: number }[] = [];
        for (const [dx, dz] of [
          [-half, -half],
          [half, -half],
          [half, half],
          [-half, half],
        ]) {
          const point = projectPoint([x + dx, y, z + dz], matrix, rect.width, rect.height);
          if (!point) return null;
          corners.push({ x: point.x, y: point.y });
        }
        return corners;
      };

      // Grid: cell sides on the active floor, faint centres on the others.
      const activeNodes = navNodesByFloor[activeFloor] ?? [];
      const lines = gridLines.get(activeFloor) ?? [];
      ctx.save();
      ctx.strokeStyle = NAV_CELL_SIDE;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (const [a, b] of lines) {
        const pa = projectPoint(a, matrix, rect.width, rect.height);
        const pb = projectPoint(b, matrix, rect.width, rect.height);
        if (!pa || !pb) continue;
        if (pa.x < -20 || pa.x > rect.width + 20 || pa.y < -20 || pa.y > rect.height + 20) continue;
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
      }
      ctx.stroke();
      ctx.restore();
      for (const node of activeNodes) {
        const point = projectPoint([nav.x[node], nav.y[node] + 0.03, nav.z[node]], matrix, rect.width, rect.height);
        if (!point) continue;
        if (point.x < -10 || point.x > rect.width + 10 || point.y < -10 || point.y > rect.height + 10) continue;
        ctx.fillStyle =
          nav.kind[node] === 1
            ? NAV_CELL_CENTRE.stair.css
            : nav.kind[node] === 2
              ? NAV_CELL_CENTRE.ramp.css
              : NAV_CELL_CENTRE.floor.css;
        ctx.fillRect(point.x - 0.6, point.y - 0.6, 1.2, 1.2);
      }
      for (let floorIndex = 0; floorIndex < navNodesByFloor.length; floorIndex++) {
        if (floorIndex === activeFloor) continue;
        for (const node of navNodesByFloor[floorIndex]) {
          const point = projectPoint([nav.x[node], nav.y[node] + 0.03, nav.z[node]], matrix, rect.width, rect.height);
          if (!point) continue;
          if (point.x < 0 || point.x > rect.width || point.y < 0 || point.y > rect.height) continue;
          ctx.fillStyle = NAV_CELL_OTHER;
          ctx.fillRect(point.x - 0.6, point.y - 0.6, 1.2, 1.2);
        }
      }

      const playerNode = nearestNode(nav, player, 3.0);
      const playerFloor = playerNode >= 0 ? nav.floor[playerNode] : nearbyRoom(quest, player).floor;
      const activeLabel = nav.floors[activeFloor]?.label ?? "";
      const playerFloorLabel = nav.floors[playerFloor]?.label ?? "";
      ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillStyle = "rgba(151, 205, 255, 0.7)";
      ctx.fillText(`GRID ${activeLabel}`, 18, rect.height - 48);
      if (playerFloor !== activeFloor) {
        ctx.fillStyle = "rgba(255, 214, 102, 0.85)";
        ctx.fillText(`PLAYER ${playerFloorLabel}`, 18, rect.height - 28);
      }

      const planNodes = new Set<number>();
      for (const step of plan) {
        planNodes.add(step.type === "move" ? step.endNode : step.node);
      }
      for (const node of planNodes) {
        const corners = cellQuad(node);
        if (!corners) continue;
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (const corner of corners.slice(1)) ctx.lineTo(corner.x, corner.y);
        ctx.closePath();
        ctx.fillStyle = "rgba(34, 211, 238, 0.22)";
        ctx.fill();
        ctx.strokeStyle = "rgba(34, 211, 238, 0.9)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      if (hovered !== null) {
        const corners = cellQuad(hovered);
        if (corners) {
          ctx.beginPath();
          ctx.moveTo(corners[0].x, corners[0].y);
          for (const corner of corners.slice(1)) ctx.lineTo(corner.x, corner.y);
          ctx.closePath();
          ctx.fillStyle = planNodes.has(hovered)
            ? "rgba(57, 255, 20, 0.06)"
            : "rgba(57, 255, 20, 0.22)";
          ctx.fill();
          ctx.strokeStyle = "rgba(57, 255, 20, 0.9)";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      const route = planPath;
      if (route.length > 1) {
        ctx.save();
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.shadowColor = "#39ff14";
        ctx.shadowBlur = 12;
        ctx.strokeStyle = "#39ff14";
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        let started = false;
        for (const p of route) {
          const point = projectPoint(p, matrix, rect.width, rect.height);
          if (!point) continue;
          if (!started) {
            ctx.moveTo(point.x, point.y);
            started = true;
          } else {
            ctx.lineTo(point.x, point.y);
          }
        }
        ctx.stroke();
        ctx.restore();
      }

      if (route.length > 1) {
        for (const d of doors) {
          if (!route.some((p) => Math.hypot(p[0] - d.x, p[2] - d.z) < 0.05)) continue;
          const point = projectPoint([d.x, d.y + 1.0, d.z], matrix, rect.width, rect.height);
          if (!point) continue;
          ctx.beginPath();
          ctx.fillStyle = "rgba(57, 255, 20, 0.16)";
          ctx.arc(point.x, point.y, 10, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#39ff14";
          ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
          ctx.fillText("door", point.x + 12, point.y + 3);
        }
      }

      const previewNow = preview;
      if (previewNow && previewNow.points.length > 1) {
        ctx.save();
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = "#7dffb0";
        ctx.lineWidth = 2;
        ctx.beginPath();
        let started = false;
        for (const p of previewNow.points) {
          const point = projectPoint(p, matrix, rect.width, rect.height);
          if (!point) continue;
          if (!started) {
            ctx.moveTo(point.x, point.y);
            started = true;
          } else {
            ctx.lineTo(point.x, point.y);
          }
        }
        ctx.stroke();
        ctx.restore();
      }

      const planEndpoint =
        route.length > 0
          ? route[route.length - 1]
          : plan.length > 0
            ? (planCursor ?? null)
            : null;
      if (planEndpoint) {
        const point = projectPoint(planEndpoint, matrix, rect.width, rect.height);
        if (point) {
          ctx.beginPath();
          ctx.strokeStyle = "#39ff14";
          ctx.lineWidth = 1.6;
          ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      if (previewNow) {
        const goal = previewNow.points[previewNow.points.length - 1];
        const point = projectPoint(goal, matrix, rect.width, rect.height);
        if (point) {
          ctx.beginPath();
          ctx.strokeStyle = "#ff9d3c";
          ctx.lineWidth = 1.6;
          ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      if (!view2D) {
        const layer = popupLayer;
        if (layer) {
          const anchor = previewNow
            ? projectPoint(previewNow.anchor, matrix, rect.width, rect.height)
            : null;
          if (!previewNow || !anchor) {
            layer.style.visibility = "hidden";
          } else {
            const geometry = popupGeometry(
              anchor,
              previewNow.choices.length,
              rect.width,
              rect.height,
            );
            layer.style.transform = `translate3d(${geometry.x}px, ${geometry.y}px, 0)`;
            layer.style.visibility = "visible";
            ctx.save();
            ctx.strokeStyle = "#ff9d3c";
            ctx.lineWidth = 1.2;
            ctx.lineCap = "round";
            ctx.shadowColor = "rgba(255, 157, 60, 0.7)";
            ctx.shadowBlur = 8;
            ctx.setLineDash([]);
            ctx.beginPath();
            for (const offset of geometry.offsets) {
              ctx.moveTo(anchor.x, anchor.y);
              ctx.lineTo(geometry.x + offset.x, geometry.y + offset.y);
            }
            ctx.stroke();
            ctx.restore();
          }
        }
      }
}
