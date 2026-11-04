import type { QuestSession, RpdActions } from "../session/types";

type FloorCount = {
  index: number;
  label: string;
  discovered: number;
  total: number;
};

type FloorSelectorProps = {
  session: QuestSession;
  actions: RpdActions;
  floors: FloorCount[];
};

export default function FloorSelector({ session, actions, floors }: FloorSelectorProps) {
  const { state, set } = session;

  return (
    <section className="rpd-floors" aria-label="Floor selector">
      {floors.map((floor) => (
        <button
          key={floor.index}
          className="rpd-floor"
          data-active={state.activeFloor === floor.index}
          onClick={(event) => {
            if (event.detail > 0) event.currentTarget.blur();
            set.activeFloor(floor.index);
          }}
        >
          <span>{floor.label}</span>
          <small>
            {floor.discovered}/{floor.total}
          </small>
        </button>
      ))}
      <button
        className="rpd-floor rpd-view-toggle"
        data-active={state.view2D}
        title="Toggle 2D floor plan"
        onClick={(event) => {
          if (event.detail > 0) event.currentTarget.blur();
          actions.toggleView2D();
        }}
      >
        <span>{state.view2D ? "3D" : "2D"}</span>
      </button>
      <button
        className="rpd-icon-button"
        title="Reset run"
        onClick={actions.reset}
        aria-label="Reset run"
      >
        ↺
      </button>
    </section>
  );
}
