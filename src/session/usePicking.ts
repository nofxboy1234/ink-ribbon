import { useRef } from "react";
import { nodePoint } from "../nav";
import { pointInQuad, projectPoint } from "../overlay/geometry";
import { nearbyRoom } from "../quest";
import type { Target } from "../planner";
import type { CanvasHandlers, QuestSession } from "./types";

export function usePicking(
  session: QuestSession,
  previewTarget: (target: Target) => void,
  dismissPreview: () => void,
) {
  const { refs, set, data, ref } = session;
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const clickHandled = useRef(false);

  const cellAt = (
    clientX: number,
    clientY: number,
    floorIndex: number,
  ): { target: Target; depth: number } | null => {
    const graph = refs.nav.current;
    const canvas = ref.overlay.current;
    if (!graph || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const matrix = refs.viewProj.current;
    const half = graph.half;
    let best: { target: Target; depth: number } | null = null;
    for (const node of data.navNodesByFloor[floorIndex] ?? []) {
      const x = graph.x[node];
      const y = graph.y[node];
      const z = graph.z[node];
      const corners: { x: number; y: number }[] = [];
      let complete = true;
      for (const [dx, dz] of [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
      ]) {
        const point = projectPoint([x + dx, y + 0.02, z + dz], matrix, rect.width, rect.height);
        if (!point) {
          complete = false;
          break;
        }
        corners.push({ x: point.x, y: point.y });
      }
      if (!complete) continue;
      if (!pointInQuad(clientX, clientY, corners)) continue;
      const centre = projectPoint([x, y + 0.02, z], matrix, rect.width, rect.height);
      const depth = centre?.depth ?? Infinity;
      if (!best || depth < best.depth) {
        best = { target: { kind: "cell", node }, depth };
      }
    }
    return best;
  };

  const pickAt = (clientX: number, clientY: number): Target | null => {
    if (!refs.view2D.current) return null;
    const active = cellAt(clientX, clientY, refs.activeFloor.current);
    if (active) return active.target;
    const graph = refs.nav.current;
    if (!graph) return null;
    for (let floor = 0; floor < graph.floors.length; floor += 1) {
      if (floor === refs.activeFloor.current) continue;
      const fallback = cellAt(clientX, clientY, floor);
      if (fallback) {
        set.activeFloor(floor);
        return fallback.target;
      }
    }
    return null;
  };

  const hoverAt = (clientX: number, clientY: number) => {
    const graph = refs.nav.current;
    const quest = refs.quest.current;
    if (!graph || !quest || !refs.view2D.current) {
      refs.hoverCell.current = null;
      set.hover(null);
      return;
    }
    const hit = cellAt(clientX, clientY, refs.activeFloor.current);
    if (hit && hit.target.kind === "cell") {
      refs.hoverCell.current = hit.target.node;
      const point = nodePoint(graph, hit.target.node);
      const room = nearbyRoom(quest, point);
      set.hover({
        kind: "cell",
        label: room.name,
        detail: "Click to add a waypoint",
        x: clientX,
        y: clientY,
      });
      return;
    }
    refs.hoverCell.current = null;
    set.hover(null);
  };

  const pickFromClick = (
    clientX: number,
    clientY: number,
    start: { x: number; y: number } | null,
  ) => {
    if (start && Math.hypot(clientX - start.x, clientY - start.y) > 5) return;
    const rect = ref.overlay.current?.getBoundingClientRect();
    if (!rect) return;
    const target = pickAt(clientX - rect.left, clientY - rect.top);
    if (target) previewTarget(target);
    else dismissPreview();
  };

  const handlers: CanvasHandlers = {
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      pointerStart.current = { x: event.clientX, y: event.clientY };
    },
    onPointerUp: (event) => {
      const start = pointerStart.current;
      pointerStart.current = null;
      if (!start) return;
      clickHandled.current = true;
      window.setTimeout(() => {
        clickHandled.current = false;
      }, 0);
      pickFromClick(event.clientX, event.clientY, start);
    },
    onClick: (event) => {
      if (clickHandled.current) return;
      const start = pointerStart.current;
      pointerStart.current = null;
      pickFromClick(event.clientX, event.clientY, start);
    },
    onPointerCancel: () => {
      pointerStart.current = null;
    },
    onPointerMove: (event) => {
      const rect = ref.overlay.current?.getBoundingClientRect();
      if (!rect) return;
      hoverAt(event.clientX - rect.left, event.clientY - rect.top);
    },
    onPointerLeave: () => {
      refs.hoverCell.current = null;
      set.hover(null);
    },
    onContextMenu: (event) => event.preventDefault(),
  };

  return { pickAt, hoverAt, handlers };
}
