import { useEffect } from "react";
import { usePlanSession } from "./session/usePlanSession";
import RpdView from "./ui/RpdView";

type RpdSceneProps = {
  assetUrl?: string;
  label?: string;
};

export default function RpdScene({
  assetUrl = "/rpd/rpd.bin",
  label = "RPD floors one to five as a 3D model",
}: RpdSceneProps) {
  const session = usePlanSession(assetUrl);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        session.actions.toggleView();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session.actions, session.state.view2D]);
  return <RpdView session={session} label={label} />;
}
