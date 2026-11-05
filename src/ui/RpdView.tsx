import { useMemo } from "react";
import type { CanvasHandlers, QuestSession, RpdActions } from "../session/types";
import FloorSelector from "./FloorSelector";
import QuestPanel from "./QuestPanel";
import RpdStage from "./RpdStage";
import RpdStatus from "./RpdStatus";

type RpdViewProps = {
  session: QuestSession;
  actions: RpdActions;
  canvasHandlers: CanvasHandlers;
  label: string;
};

export default function RpdView({ session, actions, canvasHandlers, label }: RpdViewProps) {
  const { state, ref } = session;
  const { preview } = state;

  const floorList = useMemo(() => {
    if (!state.nav) return [];
    return state.nav.floors
      .slice()
      .sort((a, b) => b.level - a.level)
      .map((floor) => ({ index: floor.index, label: floor.label }));
  }, [state.nav]);

  const statusText = state.error ? `Scene error — ${state.error}` : "Loading the RPD building";

  return (
    <main className="rpd-root" ref={ref.wrap} data-paused={state.paused}>
      <RpdStage
        session={session}
        actions={actions}
        canvasHandlers={canvasHandlers}
        label={label}
      />

      <header className="rpd-brand">
        <div className="rpd-brand-mark">RPD</div>
        <div>
          <h1>Claire A · Hardcore</h1>
          <p>Raccoon Police Department · 4F · 3F · 2F · 1F · B1</p>
        </div>
      </header>

      <FloorSelector session={session} actions={actions} floors={floorList} />

      <QuestPanel session={session} />

      <RpdStatus
        statusText={statusText}
        hidden={state.hidden}
        error={state.error}
        progress={state.progress}
        fps={state.fps}
        toast={state.toast}
      />
    </main>
  );
}
