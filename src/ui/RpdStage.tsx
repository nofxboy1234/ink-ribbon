import { useCallback } from "react";
import FloorMap2D from "../FloorMap2D";
import { fanOffset } from "../overlay/geometry";
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

  const handleMapData = useCallback(
    (vertices: Float32Array) => {
      refs.client.current?.setMapData(vertices);
    },
    [refs],
  );

  const handleMapAnchor = useCallback(
    (anchor: { x: number; y: number } | null) => {
      session.set.mapPopupAnchor(anchor);
    },
    [session.set],
  );

  return (
    <div className="rpd-stage">
      <canvas
        ref={ref.canvas}
        id="canvas"
        className="rpd-canvas"
        data-cell={hover?.kind === "cell" ? "true" : undefined}
        aria-label={label}
        {...canvasHandlers}
      />
      <canvas
        ref={ref.overlay}
        className="rpd-overlay"
        aria-hidden="true"
        style={view2D ? { display: "none" } : undefined}
      />
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
      {view2D && nav && quest && data.mapBounds && (
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
          onMapData={handleMapData}
          onCamera={handleMapCamera}
          focusToken={state.mapFocusToken}
          onPreview={actions.previewTarget}
          onPreviewAnchor={handleMapAnchor}
        />
      )}
    </div>
  );
}
