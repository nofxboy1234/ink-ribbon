import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { NavGraph } from "../nav";
import type { Quest, Vec3 } from "../quest";
import type { PlanStep } from "../planner";
import type { Target } from "../planner";
import type { MapCamera } from "./useMapCamera";

type MapPointerInput = {
  rootRef: RefObject<HTMLDivElement | null>;
  cameraRef: { current: MapCamera };
  emitCamera: () => void;
  setCameraVersion: (update: (value: number) => number) => void;
  cancelFocus: () => void;
  nav: NavGraph;
  quest: Quest;
  floor: number;
  plan: readonly PlanStep[];
  discovered: ReadonlySet<string>;
  onPreview: (target: Target) => void;
  onHoverNode?: (node: number | null, x: number, y: number) => void;
};

export function useMapPointer({
  rootRef,
  cameraRef,
  emitCamera,
  setCameraVersion,
  cancelFocus,
  nav,
  quest,
  floor,
  plan,
  discovered,
  onPreview,
  onHoverNode,
}: MapPointerInput) {
  const [hoverNode, setHoverNode] = useState<number | null>(null);
  const dragRef = useRef<{
    id: number;
    button: number;
    x: number;
    y: number;
    cx: number;
    cz: number;
    moved: number;
  } | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      cancelFocus();
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
  }, [rootRef, cameraRef, cancelFocus, emitCamera, setCameraVersion]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    cancelFocus();
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

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
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
      const hit = nearest >= 0 && best <= nav.step * 0.85 ? nearest : null;
      setHoverNode(hit);
      onHoverNode?.(hit, event.clientX, event.clientY);
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
    if (drag.button !== 1) return;
    const camera = cameraRef.current;
    cameraRef.current = {
      cx: drag.cx - dx / camera.scale,
      cz: drag.cz - dy / camera.scale,
      scale: camera.scale,
    };
    emitCamera();
    setCameraVersion((value) => value + 1);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const root = rootRef.current;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag || !root || drag.id !== event.pointerId) return;
    if (drag.button !== 0 || event.type === "pointercancel" || drag.moved > 4) return;
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

  return {
    hoverNode,
    clearHover: () => setHoverNode(null),
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onPointerLeave: () => setHoverNode(null),
      onLostPointerCapture: () => {
        dragRef.current = null;
      },
      onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.button === 1) event.preventDefault();
      },
      onAuxClick: (event: ReactMouseEvent<HTMLDivElement>) => event.preventDefault(),
      onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => event.preventDefault(),
    },
  };
}
