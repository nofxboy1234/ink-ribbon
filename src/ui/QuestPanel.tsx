import type { QuestSession } from "../session/types";

type QuestPanelProps = {
  session: QuestSession;
};

const SLOTS = 8;

export default function QuestPanel({ session }: QuestPanelProps) {
  const { state } = session;
  const { preview, playerRoom, paused } = state;

  return (
    <aside className="rpd-panel" aria-label="Route planner">
      <div className="rpd-panel-head">
        <div>
          <p className="rpd-kicker">Route planner</p>
          <h2>{preview?.label ?? playerRoom}</h2>
        </div>
        <div className="rpd-panel-status">
          {paused && <span className="rpd-paused">Paused</span>}
        </div>
      </div>

      <p className="rpd-note">{state.statusNote}</p>

      <div className="rpd-section-title">
        <span>Inventory</span>
      </div>
      <div className="rpd-inventory" data-empty="true">
        {Array.from({ length: SLOTS }, (_, index) => (
          <span className="rpd-slot" key={index} aria-label={`Empty slot ${index + 1}`} />
        ))}
      </div>

      <div className="rpd-legend">
        <div className="rpd-legend-row">
          <span className="rpd-dot" style={{ background: "#ff79c6" }} />
          <span>Claire</span>
          <span className="rpd-dot" style={{ background: "#39ff14" }} />
          <span>Route</span>
          <span className="rpd-dot" style={{ background: "#22d3ee" }} />
          <span>Waypoint</span>
        </div>
        <p className="rpd-legend-note">
          Switch to the 2D plan, then click the floor to add waypoints. Double
          click Claire to run the route.
        </p>
      </div>
    </aside>
  );
}
