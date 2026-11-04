import { useDevApi } from "./session/useDevApi";
import { useDiscovery } from "./session/useDiscovery";
import { useHotkeys } from "./session/useHotkeys";
import { usePicking } from "./session/usePicking";
import { usePlanner } from "./session/usePlanner";
import { useQuestSession } from "./session/useQuestSession";
import { useRun } from "./session/useRun";
import { useSceneEffects } from "./session/useSceneEffects";
import { useSceneLoader } from "./session/useSceneLoader";
import { useViewControls } from "./session/useViewControls";
import type { RpdActions } from "./session/types";
import RpdView from "./ui/RpdView";

type RpdSceneProps = {
  assetUrl?: string;
  label?: string;
};

export default function RpdScene({
  assetUrl = "/rpd/rpd.bin",
  label = "RPD floors one to three as a 3D model",
}: RpdSceneProps) {
  const session = useQuestSession();
  const discovery = useDiscovery(session);
  useSceneLoader(session, assetUrl, discovery.revealItems);
  const planner = usePlanner(session);
  const run = useRun(session, planner, discovery.revealItems);
  const picking = usePicking(session, planner.previewTarget, planner.dismissPreview);
  const view = useViewControls(session);
  useSceneEffects(session);
  useHotkeys(session, {
    toggleView2D: view.toggleView2D,
    toggleRenderStyle: view.toggleRenderStyle,
    pauseAndClearRoute: planner.pauseAndClearRoute,
  });
  useDevApi(session, planner, run, picking.pickAt);

  const actions: RpdActions = {
    toggleView2D: view.toggleView2D,
    reset: run.reset,
    focusRoute: planner.focusRoute,
    undoPlan: planner.undoPlan,
    clearPlan: planner.clearPlan,
    runPlan: run.runPlan,
    previewTarget: planner.previewTarget,
    commitChoice: planner.commitChoice,
  };

  return (
    <RpdView
      session={session}
      actions={actions}
      canvasHandlers={picking.handlers}
      label={label}
    />
  );
}
