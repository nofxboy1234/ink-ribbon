import { useEffect, useState } from "react";

import type { PlanSession } from "../session/usePlanSession";

type SavePanelProps = {
  session: PlanSession;
};

type Slot = {
  savedAt: number;
  floor: number;
  items: number;
  data: number[];
} | null;

const KEY = "rpd.saves.v1";

function readSlots(): Slot[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [null, null, null];
    const parsed = JSON.parse(raw) as Slot[];
    return [parsed[0] ?? null, parsed[1] ?? null, parsed[2] ?? null];
  } catch {
    return [null, null, null];
  }
}

export default function SavePanel({ session }: SavePanelProps) {
  const [slots, setSlots] = useState<Slot[]>(() => readSlots());
  const [message, setMessage] = useState("");

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(slots));
  }, [slots]);

  const save = (index: number) => {
    const snapshot = session.actions.save();
    if (!snapshot) {
      setMessage("The save is not ready yet.");
      return;
    }
    const next = slots.slice();
    next[index] = {
      savedAt: Date.now(),
      floor: session.state.activeFloor,
      items: session.state.inventory.filter(Boolean).length,
      data: snapshot,
    };
    setSlots(next);
    setMessage(`Saved to slot ${index + 1}.`);
  };

  const load = (index: number) => {
    const slot = slots[index];
    if (!slot) return;
    const result = session.actions.restore(slot.data);
    setMessage(result === 0 ? `Loaded slot ${index + 1}.` : `Slot ${index + 1} would not load (${result}).`);
  };

  return (
    <div className="rpd-save">
      <div className="rpd-section-title">
        <span>Typewriter saves</span>
      </div>
      {!session.state.atTypewriter && (
        <p className="rpd-save-message">Stand at a typewriter to save.</p>
      )}
      {slots.map((slot, index) => (
        <div className="rpd-save-slot" key={index}>
          <span className="rpd-save-name">Slot {index + 1}</span>
          <span className="rpd-save-meta">
            {slot ? new Date(slot.savedAt).toLocaleTimeString() : "Empty"}
          </span>
          <button type="button" disabled={!session.state.atTypewriter} onClick={() => save(index)}>
            Save
          </button>
          <button type="button" disabled={!slot} onClick={() => load(index)}>
            Load
          </button>
        </div>
      ))}
      {message && <p className="rpd-save-message">{message}</p>}
    </div>
  );
}
