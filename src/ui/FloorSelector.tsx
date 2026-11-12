import type { PlanSession } from "../session/usePlanSession";

type FloorSelectorProps = {
  session: PlanSession;
};

export default function FloorSelector({ session }: FloorSelectorProps) {
  const { state, actions } = session;
  return (
    <section className="rpd-floors" aria-label="Floor selector">
      {state.floors.map((floor) => (
        <button
          key={floor.index}
          className="rpd-floor"
          data-active={state.activeFloor === floor.index}
          onClick={(event) => {
            if (event.detail > 0) event.currentTarget.blur();
            actions.setFloor(floor.index);
          }}
        >
          <span>{floor.label}</span>
        </button>
      ))}
      <button
        className="rpd-icon-button"
        title="Reset view"
        onClick={actions.resetView}
        aria-label="Reset view"
      >
        ↺
      </button>
      <button
        className="rpd-icon-button rpd-recenter-button"
        data-recenter="true"
        title="Recenter on Claire (C)"
        onClick={actions.recenter}
        aria-label="Recenter on Claire"
      >
        ◎
      </button>
    </section>
  );
}
