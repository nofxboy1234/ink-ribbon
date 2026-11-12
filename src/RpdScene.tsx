import { usePlanSession } from "./session/usePlanSession";
import RpdView from "./ui/RpdView";

type RpdSceneProps = {
  assetUrl?: string;
  label?: string;
};

export default function RpdScene({
  assetUrl = "/rpd/rpd.bin",
  label = "RPD floor plan",
}: RpdSceneProps) {
  const session = usePlanSession(assetUrl);
  return <RpdView session={session} label={label} />;
}
