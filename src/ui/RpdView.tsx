import type { PlanSession } from "../session/usePlanSession";
import CodeEntry from "./CodeEntry";
import FloorSelector from "./FloorSelector";
import QuestPanel from "./QuestPanel";
import RpdStage from "./RpdStage";
import RpdStatus from "./RpdStatus";

type RpdViewProps = {
  session: PlanSession;
  label: string;
};

export default function RpdView({ session, label }: RpdViewProps) {
  const { state } = session;
  const floorLabel =
    state.floors.find((floor) => floor.index === state.activeFloor)?.label ?? "1F";
  const statusText = state.error ? `Scene error · ${state.error}` : "Loading the RPD building";

  return (
    <main className="rpd-root">
      <RpdStage session={session} label={label} />
      <header className="rpd-brand">
        <div className="rpd-brand-mark">RPD</div>
        <div>
          <h1>Claire A · Hardcore</h1>
          <p>Raccoon Police Department · 4F · 3F · 2F · 1F · B1</p>
        </div>
      </header>
      <FloorSelector session={session} />
      <CodeEntry session={session} />
      <QuestPanel session={session} />
      {state.view2D && (
        <div className="rpd-map-title">
          <strong>{floorLabel} · FLOOR PLAN</strong>
          <span>wheel to zoom · middle drag to pan · right click for waypoints</span>
        </div>
      )}
      <RpdStatus
        statusText={statusText}
        hidden={state.loaded}
        error={state.error}
        progress={state.progress}
        toast=""
      />
    </main>
  );
}
