import { useEffect, useRef, useState } from "react";
import type { PlanSession } from "../session/usePlanSession";

type CodeEntryProps = {
  session: PlanSession;
};

const MESSAGES: Record<number, string> = {
  0: "UNLOCKED",
  [-2]: "A REQUIRED ITEM IS MISSING",
  [-3]: "THIS LOCK IS ALREADY OPEN",
  [-5]: "TYPE THE CODE FIRST",
  [-6]: "WRONG CODE",
  [-7]: "READ THE HINT FIRST",
};

export default function CodeEntry({ session }: CodeEntryProps) {
  const lock = session.state.codeLock;
  const [entry, setEntry] = useState("");
  const [message, setMessage] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEntry("");
    setMessage("");
    if (lock?.hintKnown) input.current?.focus();
  }, [lock?.item, lock?.hintKnown]);

  if (!lock) return null;

  return (
    <form
      className="rpd-code"
      onSubmit={(event) => {
        event.preventDefault();
        if (!lock.hintKnown) return;
        const result = session.actions.enterCode(entry);
        if (result !== 0) setMessage(MESSAGES[result] ?? "THE CODE WAS REFUSED");
      }}
    >
      <div className="rpd-code-head">
        <div>
          <p className="rpd-kicker">Code lock</p>
          <h2>{lock.title}</h2>
        </div>
        <button
          type="button"
          className="rpd-code-close"
          onClick={session.actions.closeCodeEntry}
          aria-label="Close code entry"
        >
          ×
        </button>
      </div>
      <p className="rpd-code-hint">
        {lock.hintKnown ? "Enter the code from the file you read." : `Read ${lock.hint} before entering the code.`}
      </p>
      <div className="rpd-code-row">
        <input
          ref={input}
          className="rpd-code-input"
          value={entry}
          onChange={(event) => setEntry(event.target.value)}
          disabled={!lock.hintKnown}
          autoComplete="off"
          spellCheck={false}
          aria-label="Lock code"
          placeholder={lock.title === "Dial Lock" ? "C-A-P" : "L9 R15 L7"}
        />
        <button type="submit" className="rpd-code-submit" disabled={!lock.hintKnown || entry.trim() === ""}>
          Enter
        </button>
      </div>
      {message && <p className="rpd-code-message">{message}</p>}
    </form>
  );
}
