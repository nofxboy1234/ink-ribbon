import type { QuestSession, RpdActions } from "../session/types";

type FloorEntry = {
  index: number;
  label: string;
};

type FloorSelectorProps = {
  session: QuestSession;
  actions: RpdActions;
  floors: FloorEntry[];
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
        </button>
      ))}
      <button
        className="rpd-floor rpd-view-toggle"
        data-active={state.view2D}
        title="Animate between the perspective and top-down plan"
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
