import { useEffect, useMemo, useRef } from "react";
import type { NavGraph } from "./nav";
import type { DoorState, Quest, Vec3 } from "./quest";
import type { PlanStep, Preview, Target } from "./planner";
import { buildMapGeometry } from "./map/geometry";
import { useMapCamera } from "./map/useMapCamera";
import { useMapPointer } from "./map/useMapPointer";
import { MapLabels } from "./map/MapLabels";

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
  const floorLevel = quest.floors[floor]?.level ?? 0;

  const { cameraRef, cameraVersion, viewport, emitCamera, setCameraVersion, cancelFocus } =
    useMapCamera({
      rootRef,
      floor,
      floorLevel,
      mapBounds,
      focusToken,
      player,
      onCamera,
    });
  const { hoverNode, handlers } = useMapPointer({
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
  });

  const mapGeometry = useMemo(
    () =>
      buildMapGeometry({
        nav,
        quest,
        floor,
        discovered,
        doorStates,
        plan,
        planPath,
        preview,
        hoverNode,
      }),
    [nav, quest, floor, discovered, doorStates, plan, planPath, preview, hoverNode],
  );

  useEffect(() => {
    onMapData(mapGeometry);
  }, [mapGeometry, onMapData]);

  useEffect(() => {
    const root = rootRef.current;
    if (!preview || !root) {
      onPreviewAnchor(null);
      return;
    }
    const rect = root.getBoundingClientRect();
    const camera = cameraRef.current;
    onPreviewAnchor({
      x: (preview.anchor[0] - camera.cx) * camera.scale + rect.width / 2,
      y: (preview.anchor[2] - camera.cz) * camera.scale + rect.height / 2,
    });
  }, [preview, cameraVersion, viewport, cameraRef, onPreviewAnchor]);

  return (
    <div className="rpd-map" ref={rootRef}>
      <MapLabels
        nav={nav}
        quest={quest}
        floor={floor}
        player={player}
        camera={cameraRef.current}
        viewport={viewport}
      />
      <div className="rpd-map-hit" {...handlers} />
    </div>
  );
}
