import type { QuestSession, RpdActions } from "../session/types";

type RouteDockProps = {
  session: QuestSession;
  actions: RpdActions;
};

export default function RouteDock({ session, actions }: RouteDockProps) {
  const { state, ref } = session;

  return (
    <section className="rpd-route-dock" ref={ref.dock} aria-label="Route">
      <div className="rpd-route-dock-head">
        <span>Route</span>
        <span className="rpd-muted">
          {state.plan.length} step{state.plan.length === 1 ? "" : "s"}
        </span>
      </div>
      <ol className="rpd-route-steps">
        {state.plan.map((step, index) => (
          <li key={`${index}-${step.label}`}>
            <span className="rpd-step-number">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span>{step.label}</span>
          </li>
        ))}
      </ol>
      <div className="rpd-dock-actions">
        <button className="rpd-text-button" onClick={actions.focusRoute}>
          focus
        </button>
        <button
          className="rpd-text-button"
          onClick={actions.undoPlan}
          disabled={state.moving}
        >
          undo
        </button>
        <button
          className="rpd-text-button"
          onClick={actions.clearPlan}
          disabled={state.moving}
        >
          clear
        </button>
      </div>
      <button
        className="rpd-confirm"
        onClick={actions.runPlan}
        disabled={state.paused || state.moving}
      >
        {state.paused ? "Paused · Esc to resume" : state.moving ? "Moving…" : "Run route"}
      </button>
    </section>
  );
}
