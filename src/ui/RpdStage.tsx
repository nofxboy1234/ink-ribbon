import type { PlanSession } from "../session/usePlanSession";

type RpdStageProps = {
  session: PlanSession;
  label: string;
};

export default function RpdStage({ session, label }: RpdStageProps) {
  return (
    <div className="rpd-stage">
      <canvas
        ref={session.ref.canvas}
        id="canvas"
        className="rpd-canvas"
        aria-label={label}
      />
    </div>
  );
}
