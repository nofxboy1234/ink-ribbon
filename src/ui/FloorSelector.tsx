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
        className="rpd-floor rpd-view-toggle"
        data-active={state.view2D}
        title="Animate between the perspective and top-down plan"
        onClick={(event) => {
          if (event.detail > 0) event.currentTarget.blur();
          actions.toggleView();
        }}
      >
        <span>{state.view2D ? "3D" : "2D"}</span>
      </button>
      <button
        className="rpd-icon-button"
        title="Reset route"
        onClick={actions.reset}
        aria-label="Reset route"
      >
        ↺
      </button>
    </section>
  );
}
