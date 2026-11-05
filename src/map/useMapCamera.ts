import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Vec3 } from "../quest";

export type MapCamera = { cx: number; cz: number; scale: number };

type MapCameraInput = {
  rootRef: RefObject<HTMLDivElement | null>;
  floor: number;
  floorLevel: number;
  mapBounds: [number, number, number, number];
  focusToken: number;
  player: Vec3;
  onCamera: (
    cx: number,
    cz: number,
    scale: number,
    vw: number,
    vh: number,
    floorY: number,
  ) => void;
};

export function useMapCamera({
  rootRef,
  floor,
  floorLevel,
  mapBounds,
  focusToken,
  player,
  onCamera,
}: MapCameraInput) {
  const cameraRef = useRef<MapCamera>({ cx: 0, cz: 0, scale: 8 });
  const offsetRef = useRef({ x: 0, y: 0 });
  const focusAnimRef = useRef(0);
  const [cameraVersion, setCameraVersion] = useState(0);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  const emitCamera = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const camera = cameraRef.current;
    onCamera(camera.cx, camera.cz, camera.scale, rect.width, rect.height, floorLevel);
  }, [rootRef, onCamera, floorLevel]);

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
    // Park the plan in the free area left of the side panel rather than in
    // the middle of the window.
    const plotCx = left + plotW / 2;
    const plotCy = top + plotH / 2;
    offsetRef.current = {
      x: (plotCx - rect.width / 2) / scale,
      y: (plotCy - rect.height / 2) / scale,
    };
    cameraRef.current = {
      cx: (mapBounds[0] + mapBounds[2]) / 2 - offsetRef.current.x,
      cz: (mapBounds[1] + mapBounds[3]) / 2 - offsetRef.current.y,
      scale,
    };
    setViewport({ width: rect.width, height: rect.height });
    emitCamera();
    setCameraVersion((value) => value + 1);
  }, [floor, mapBounds, emitCamera]);

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
  }, [floor, emitCamera]);

  useEffect(() => {
    if (focusToken === 0) return;
    const from = { ...cameraRef.current };
    const started = performance.now();
    const duration = 420;
    const animate = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      cameraRef.current = {
        cx: from.cx + (player[0] - offsetRef.current.x - from.cx) * ease,
        cz: from.cz + (player[2] - offsetRef.current.y - from.cz) * ease,
        scale: from.scale,
      };
      emitCamera();
      setCameraVersion((value) => value + 1);
      if (t < 1) focusAnimRef.current = requestAnimationFrame(animate);
    };
    focusAnimRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(focusAnimRef.current);
  }, [focusToken]);

  const cancelFocus = useCallback(() => {
    cancelAnimationFrame(focusAnimRef.current);
  }, []);

  return { cameraRef, cameraVersion, viewport, emitCamera, setCameraVersion, cancelFocus };
}
