import type { Item } from "../quest";
import type { QuestSession } from "../session/types";

type QuestPanelProps = {
  session: QuestSession;
  linkedItem: Item | undefined;
};

export default function QuestPanel({ session, linkedItem }: QuestPanelProps) {
  const { state, set, data } = session;
  const { preview, playerRoom, paused, discovered, picked } = state;
  const { items, keyItems, itemLookup, doorLookup } = data;

  return (
    <aside className="rpd-panel" aria-label="Quest planner">
      <div className="rpd-panel-head">
        <div>
          <p className="rpd-kicker">Quest planner</p>
          <h2>{preview?.label ?? playerRoom}</h2>
        </div>
        <div className="rpd-panel-status">
          {paused && <span className="rpd-paused">Paused</span>}
          <span className="rpd-badge">
            {discovered.size}/{items.length}
          </span>
        </div>
      </div>

      <p className="rpd-note">{state.statusNote}</p>

      {linkedItem && linkedItem.links.length + linkedItem.itemLinks.length > 0 && (
        <div className="rpd-links">
          <span>Links</span>
          <p>
            {[
              ...linkedItem.links
                .map((id) => doorLookup.get(id)?.label)
                .filter(Boolean),
              ...linkedItem.itemLinks
                .map((id) => itemLookup.get(id)?.name)
                .filter(Boolean),
            ].join(" · ")}
          </p>
        </div>
      )}

      <div className="rpd-section-title">
        <span>Inventory</span>
        <button
          className="rpd-text-button"
          title="Toggle inventory"
          aria-expanded={state.showInventory}
          onClick={() => set.showInventory((value) => !value)}
        >
          {state.showInventory ? "hide" : "show"}
        </button>
      </div>
      {state.showInventory && (
        <div className="rpd-inventory">
          {keyItems.length === 0 ? (
            <p className="rpd-empty">No key items yet.</p>
          ) : (
            keyItems.map(([name, count]) => (
              <span className="rpd-chip" key={name}>
                {name}
                {count > 1 ? ` ×${count}` : ""}
              </span>
            ))
          )}
          <p className="rpd-inventory-meta">
            {picked.size} items collected · {discovered.size} discovered
          </p>
        </div>
      )}

      <div className="rpd-legend-toggle">
        <button className="rpd-text-button" onClick={() => set.showLegend((value) => !value)}>
          {state.showLegend ? "hide legend" : "show legend"}
        </button>
      </div>
      {state.showLegend && (
        <div className="rpd-legend">
          <div className="rpd-legend-row">
            <span className="rpd-dot" style={{ background: "#b45cff" }} />
            <span>Key</span>
            <span className="rpd-dot" style={{ background: "#ff5cd0" }} />
            <span>Key item</span>
          </div>
          <div className="rpd-legend-row">
            <span className="rpd-dot" style={{ background: "#43d17a" }} />
            <span>Healing</span>
            <span className="rpd-dot" style={{ background: "#f2c94c" }} />
            <span>Ammo</span>
          </div>
          <div className="rpd-legend-row">
            <span className="rpd-dot" style={{ background: "#ff7a45" }} />
            <span>Weapon</span>
            <span className="rpd-dot" style={{ background: "#2dd4bf" }} />
            <span>Upgrade</span>
          </div>
          <div className="rpd-legend-row">
            <span className="rpd-door-key" style={{ background: "#d62828" }} />
            <span>Locked</span>
            <span className="rpd-door-key" style={{ background: "#1f77b4" }} />
            <span>Unlocked</span>
            <span className="rpd-door-key" style={{ background: "#7f7f7f" }} />
            <span>Unknown</span>
          </div>
          <div className="rpd-legend-row">
            <span className="rpd-dot" style={{ background: "#22d3ee" }} />
            <span>Waypoint</span>
          </div>
          <p className="rpd-legend-note">
            Items stay hidden until Claire walks near them. Click a discovered
            item or a floor cell to preview a route. Routes stop beside items.
          </p>
        </div>
      )}
    </aside>
  );
}
