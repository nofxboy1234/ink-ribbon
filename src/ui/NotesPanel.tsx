import { useState } from "react";

import type { PlanSession } from "../session/usePlanSession";

type NotesPanelProps = {
  session: PlanSession;
};

export default function NotesPanel({ session }: NotesPanelProps) {
  const [tab, setTab] = useState<"inventory" | "notes">("inventory");
  const notes = session.state.notes;

  return (
    <div className="rpd-notes">
      <div className="rpd-notes-tabs">
        <button type="button" data-active={tab === "inventory"} onClick={() => setTab("inventory")}>
          Inventory
        </button>
        <button type="button" data-active={tab === "notes"} onClick={() => setTab("notes")}>
          Notes
        </button>
      </div>
      {tab === "notes" && (
        <div className="rpd-notes-list">
          {notes.length === 0 && <p className="rpd-notes-empty">No notes collected yet.</p>}
          {notes.map((note) => (
            <article className="rpd-note" key={note.id}>
              <h3>{note.title}</h3>
              <p>{note.body}</p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
