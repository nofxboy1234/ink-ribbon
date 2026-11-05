import type { CSSProperties } from "react";

type RpdStatusProps = {
  statusText: string;
  hidden: boolean;
  error: string | null;
  progress: number;
  toast: string;
};

export default function RpdStatus({
  statusText,
  hidden,
  error,
  progress,
  toast,
}: RpdStatusProps) {
  return (
    <>
      {toast && <div className="rpd-toast">{toast}</div>}
      <div
        className="rpd-status"
        data-hidden={hidden}
        data-error={error !== null}
        style={{ "--progress": `${Math.round(progress * 100)}%` } as CSSProperties}
        aria-live="polite"
      >
        <div className="rpd-status-inner">
          <span>{error ? statusText : `${statusText} · ${Math.round(progress * 100)}%`}</span>
          <span className="rpd-status-mark" />
        </div>
      </div>
    </>
  );
}
