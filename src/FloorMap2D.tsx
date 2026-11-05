import { useEffect, useRef } from "react";
import type { NavGraph } from "./nav";
import type { DoorState, Quest, Vec3 } from "./quest";
import type { PlanStep, Preview, Target } from "./planner";
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
  onHoverNode?: (node: number | null, x: number, y: number) => void;
  active: boolean;
};

/**
 * Headless orthographic camera and room labels for the plan view. The 3D
 * canvas draws the model; this component publishes the map camera so the C
 * renderer can build its orthographic projection, and hosts the labels.
 */
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
  focusToken,
  onPreview,
  onPreviewAnchor,
  onHoverNode,
  active,
}: FloorMap2DProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const floorLevel = nav.floors[floor]?.level ?? quest.floors[floor]?.level ?? 0;

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
  const { handlers } = useMapPointer({
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
  });

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

  void doorStates;
  void planPath;

  return (
    <div className="rpd-map" ref={rootRef} data-active={active ? "true" : "false"}>
      {active && (
        <MapLabels
          nav={nav}
          quest={quest}
          floor={floor}
          player={player}
          camera={cameraRef.current}
          viewport={viewport}
        />
      )}
      <div className="rpd-map-hit" {...(active ? handlers : {})} />
    </div>
  );
}
