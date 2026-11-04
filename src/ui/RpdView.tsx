import { useMemo } from "react";
import type { CanvasHandlers, QuestSession, RpdActions } from "../session/types";
import FloorSelector from "./FloorSelector";
import QuestPanel from "./QuestPanel";
import RouteDock from "./RouteDock";
import RpdStage from "./RpdStage";
import RpdStatus from "./RpdStatus";

type RpdViewProps = {
  session: QuestSession;
  actions: RpdActions;
  canvasHandlers: CanvasHandlers;
  label: string;
};

export default function RpdView({ session, actions, canvasHandlers, label }: RpdViewProps) {
  const { state, data, ref } = session;
  const { quest, preview } = state;

  const floorCounts = useMemo(() => {
    if (!quest) return [];
    return quest.floors.map((floor) => ({
      ...floor,
      discovered: quest.items.filter(
        (item) => state.discovered.has(item.id) && Math.abs(item.y - floor.level - 0.36) < 0.8,
      ).length,
      total: quest.items.filter((item) => Math.abs(item.y - floor.level - 0.36) < 0.8).length,
    }));
  }, [quest, state.discovered]);

  const linkedItem =
    preview?.target.kind === "item" ? data.itemLookup.get(preview.target.id) : undefined;

  const statusText = state.error ? `Scene error — ${state.error}` : "Loading RPD floors 1–3";

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
          <p>Raccoon Police Department · 1F–3F</p>
        </div>
      </header>

      <FloorSelector session={session} actions={actions} floors={floorCounts} />

      <QuestPanel session={session} linkedItem={linkedItem} />

      {state.plan.length > 0 && <RouteDock session={session} actions={actions} />}

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
