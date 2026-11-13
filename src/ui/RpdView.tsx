import type { PlanSession } from "../session/usePlanSession";
import RpdStage from "./RpdStage";

type RpdViewProps = {
  session: PlanSession;
  label: string;
};

export default function RpdView({ session, label }: RpdViewProps) {
  return (
    <main className="rpd-root">
      <RpdStage session={session} label={label} />
    </main>
  );
}
