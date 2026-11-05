import { useCallback } from "react";
import FloorMap2D from "../FloorMap2D";
import { fanOffset, projectPoint } from "../overlay/geometry";
import { nodePoint } from "../nav";
import { nearbyRoom } from "../quest";
import type { CanvasHandlers, QuestSession, RpdActions } from "../session/types";

type RpdStageProps = {
  session: QuestSession;
  actions: RpdActions;
  canvasHandlers: CanvasHandlers;
  label: string;
};

export default function RpdStage({ session, actions, canvasHandlers, label }: RpdStageProps) {
  const { state, data, refs, ref } = session;
  const { quest, nav, activeFloor, view2D, preview, hover, player, discovered, doorStates, plan } =
    state;

  const handleMapCamera = useCallback(
    (cx: number, cz: number, scale: number, vw: number, vh: number, floorY: number) => {
      refs.client.current?.setMapCamera(cx, cz, scale, vw, vh, floorY);
    },
    [refs],
  );

  const handleMapAnchor = useCallback(
    (anchor: { x: number; y: number } | null) => {
      session.set.mapPopupAnchor(anchor);
    },
    [session.set],
  );

  const handleHoverNode = useCallback(
    (node: number | null, clientX: number, clientY: number) => {
      refs.hoverCell.current = node;
      if (node === null) {
        session.set.hover(null);
        return;
      }
      const graph = refs.nav.current;
      const questRef = refs.quest.current;
      if (!graph || !questRef) return;
      const point = nodePoint(graph, node);
      session.set.hover({
        kind: "cell",
        label: nearbyRoom(questRef, point).name,
        detail: "Click to add a waypoint",
        x: clientX,
        y: clientY,
      });
    },
    [refs.nav, refs.quest, refs.hoverCell, session.set],
  );

  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!view2D) return;
      const canvas = ref.overlay.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (!refs.nav.current) return;
      const point = projectPoint(
        [player[0], player[1] + 0.55, player[2]],
        refs.viewProj.current,
        rect.width,
        rect.height,
      );
      if (!point) return;
      const dx = event.clientX - rect.left - point.x;
      const dy = event.clientY - rect.top - point.y;
      if (Math.hypot(dx, dy) > 52) return;
      event.preventDefault();
      actions.runPlan();
    },
    [actions, player, refs.nav, refs.viewProj, ref.overlay, view2D],
  );

  return (
    <div className="rpd-stage" onDoubleClick={handleDoubleClick}>
      <canvas
        ref={ref.canvas}
        id="canvas"
        className="rpd-canvas"
        data-cell={hover?.kind === "cell" ? "true" : undefined}
        aria-label={label}
        {...canvasHandlers}
      />
      <canvas ref={ref.overlay} className="rpd-overlay" aria-hidden="true" />
      <div
        className="rpd-popup-layer"
        ref={ref.popupLayer}
        data-visible={preview ? "true" : "false"}
      >
        {preview?.choices.map((choice, index) => {
          const offset = fanOffset(index, preview.choices.length);
          return (
            <button
              key={`${choice.kind}-${choice.label}-${index}`}
              className="rpd-popup-choice"
              data-kind={choice.kind}
              disabled={choice.kind === "info"}
              style={{
                transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)`,
              }}
              onClick={() => actions.commitChoice(choice)}
            >
              {choice.label}
            </button>
          );
        })}
      </div>
      {!view2D && hover && !preview && (
        <div className="rpd-tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <strong>{hover.label}</strong>
          <span>{hover.detail}</span>
        </div>
      )}
      {nav && quest && data.mapBounds && (
        <FloorMap2D
          nav={nav}
          quest={quest}
          floor={activeFloor}
          player={player}
          discovered={discovered}
          doorStates={doorStates}
          plan={plan}
          planPath={data.planPath}
          mapBounds={data.mapBounds}
          preview={preview}
          onCamera={handleMapCamera}
          focusToken={state.mapFocusToken}
          onPreview={actions.previewTarget}
          onPreviewAnchor={handleMapAnchor}
          onHoverNode={handleHoverNode}
          active={view2D}
        />
      )}
    </div>
  );
}
