import { useRef } from "react";
import { nodePoint } from "../nav";
import { pointInQuad, projectPoint } from "../overlay/geometry";
import { CATEGORY_LABELS, itemSatisfied, nearbyRoom } from "../quest";
import type { Target } from "../planner";
import { itemPoint } from "./scene";
import type { CanvasHandlers, Hover, QuestSession } from "./types";

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
    const quest = refs.quest.current;
    const canvas = ref.overlay.current;
    if (!quest || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const matrix = refs.viewProj.current;
    const nearest: { target: Target; distance: number; kind: number }[] = [];
    for (const item of quest.items) {
      if (!refs.discovered.current.has(item.id) || refs.picked.current.has(item.id)) continue;
      const point = projectPoint(itemPoint(item), matrix, rect.width, rect.height);
      if (!point) continue;
      const distance = Math.hypot(point.x - clientX, point.y - clientY);
      if (distance < 26) nearest.push({ target: { kind: "item", id: item.id }, distance, kind: 0 });
    }
    for (const door of quest.doors) {
      const point = projectPoint([door.x, door.y + 1.05, door.z], matrix, rect.width, rect.height);
      if (!point) continue;
      const distance = Math.hypot(point.x - clientX, point.y - clientY);
      if (distance < 26) nearest.push({ target: { kind: "door", id: door.id }, distance, kind: 1 });
    }
    nearest.sort((a, b) => a.kind - b.kind || a.distance - b.distance);
    if (nearest.length > 0 && nearest[0].distance < 24) return nearest[0].target;
    const active = cellAt(clientX, clientY, refs.activeFloor.current);
    if (active) return active.target;
    for (const floor of quest.floors) {
      if (floor.index === refs.activeFloor.current) continue;
      const fallback = cellAt(clientX, clientY, floor.index);
      if (fallback) {
        set.activeFloor(floor.index);
        return fallback.target;
      }
    }
    return null;
  };

  const hoverAt = (clientX: number, clientY: number) => {
    const quest = refs.quest.current;
    const canvas = ref.overlay.current;
    if (!quest || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const matrix = refs.viewProj.current;
    let best: { hover: Hover; distance: number } | null = null;
    for (const item of quest.items) {
      if (!refs.discovered.current.has(item.id) || refs.picked.current.has(item.id)) continue;
      const point = projectPoint(itemPoint(item), matrix, rect.width, rect.height);
      if (!point) continue;
      const distance = Math.hypot(point.x - clientX, point.y - clientY);
      if (distance < 22 && (!best || distance < best.distance)) {
        best = {
          distance,
          hover: {
            kind: "item",
            label: item.name,
            detail: `${item.location} · ${CATEGORY_LABELS[item.category] ?? "Item"}${
              item.links.length
                ? ` · unlocks ${item.links
                    .map((id) => data.doorLookup.get(id)?.label)
                    .filter(Boolean)
                    .join(", ")}`
                : ""
            }${item.itemLinks.length ? ` · links ${item.itemLinks
              .map((id) => data.itemLookup.get(id)?.name)
              .filter(Boolean)
              .join(", ")}` : ""}${!itemSatisfied(item, refs.inventory.current) ? ` · needs ${item.requires.join(" / ")}` : ""}`,
            x: clientX,
            y: clientY,
          },
        };
      }
    }
    for (const door of quest.doors) {
      const point = projectPoint([door.x, door.y + 1.05, door.z], matrix, rect.width, rect.height);
      if (!point) continue;
      const distance = Math.hypot(point.x - clientX, point.y - clientY);
      if (distance < 22 && (!best || distance < best.distance)) {
        const state = refs.doorStates.current.get(door.id) ?? door.state;
        best = {
          distance,
          hover: {
            kind: "door",
            label: door.label,
            detail:
              state === "locked"
                ? `Locked${door.requires.length ? ` · ${door.requires.join(" / ")}` : ""}`
                : state === "unlocked"
                  ? "Unlocked"
                  : "Unknown",
            x: clientX,
            y: clientY,
          },
        };
      }
    }
    if (!best) {
      const cellHit = cellAt(clientX, clientY, refs.activeFloor.current);
      if (cellHit && cellHit.target.kind === "cell") {
        refs.hoverCell.current = cellHit.target.node;
        const graph = refs.nav.current;
        if (graph) {
          const point = nodePoint(graph, cellHit.target.node);
          const room = nearbyRoom(quest, point);
          set.hover({
            kind: "cell",
            label: room.name,
            detail: "Click this floor cell to move Claire here",
            x: clientX,
            y: clientY,
          });
        }
        return;
      }
    }
    refs.hoverCell.current = null;
    set.hover(best?.hover ?? null);
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
