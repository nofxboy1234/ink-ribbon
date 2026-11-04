import type { Vec3 } from "../quest";
import { nearbyRoom } from "../quest";
import { nearestNode, nodePoint } from "../nav";
import {
  appendChoiceSteps,
  buildPreview,
  planStateFor,
  type PlanChoice,
  type PlanState,
  type PlanStep,
  type Target,
} from "../planner";
import { distance3 } from "./scene";
import type { QuestSession } from "./types";

export function usePlanner(session: QuestSession) {
  const { refs, set, data, ref } = session;
  const { itemLookup, itemNodes } = data;

  const cellLabelFor = (node: number): string => {
    const graph = refs.nav.current;
    const quest = refs.quest.current;
    if (!graph || !quest) return "Floor";
    return nearbyRoom(quest, nodePoint(graph, node)).name;
  };

  const stateForPlan = (steps: readonly PlanStep[]): PlanState | null => {
    const graph = refs.nav.current;
    const quest = refs.quest.current;
    if (!graph || !quest) return null;
    return planStateFor({
      plan: steps,
      inventory: refs.inventory.current,
      picked: refs.picked.current,
      doorStates: refs.doorStates.current,
      player: refs.player.current,
      nav: graph,
      itemLookup,
    });
  };

  const currentPlanState = (): PlanState | null => {
    const state = stateForPlan(refs.plan.current);
    if (state) refs.planState.current = state;
    return state;
  };

  const closePreview = () => {
    refs.preview.current = null;
    set.preview(null);
    set.hover(null);
    const layer = ref.popupLayer.current;
    if (layer) layer.style.visibility = "hidden";
  };

  const dismissPreview = () => {
    closePreview();
    const count = refs.plan.current.length;
    set.statusNote(
      count > 0
        ? `Plan has ${count} step${count === 1 ? "" : "s"}.`
        : "Preview closed.",
    );
  };

  const previewTarget = (target: Target) => {
    if (refs.moving.current) return;
    const graph = refs.nav.current;
    const quest = refs.quest.current;
    if (!graph || !quest) return;
    let resolved = target;
    if (resolved.kind === "cell") {
      const itemHere = itemNodes
        .get(resolved.node)
        ?.find(
          (item) =>
            refs.discovered.current.has(item.id) && !refs.picked.current.has(item.id),
        );
      if (itemHere) resolved = { kind: "item", id: itemHere.id };
    }
    const state = currentPlanState();
    if (!state) return;
    let problem = "";
    const next = buildPreview({
      target: resolved,
      state,
      nav: graph,
      doors: quest.doors,
      itemLookup,
      itemNodes,
      cellLabel: cellLabelFor,
      report: (reason) => {
        problem = reason;
      },
    });
    if (!next) {
      const reason = problem || "No route.";
      closePreview();
      set.toast(reason);
      set.statusNote(reason);
      return;
    }
    const layer = ref.popupLayer.current;
    if (layer) layer.style.visibility = "hidden";
    refs.preview.current = next;
    set.preview(next);
    set.hover(null);
    set.statusNote(`Preview to ${next.label}. Choose an action.`);
  };

  const appendPlan = (steps: PlanStep[]): PlanStep[] => {
    const next = [...refs.plan.current, ...steps];
    refs.plan.current = next;
    const state = stateForPlan(next);
    if (state) refs.planState.current = state;
    set.plan(next);
    return next;
  };

  const commitChoice = (choice: PlanChoice) => {
    if (choice.kind === "info") return;
    const current = refs.preview.current;
    if (!current) return;
    const steps = appendChoiceSteps(current, choice);
    if (steps.length === 0) {
      set.toast(`Already at ${current.label}.`);
      closePreview();
      return;
    }
    const next = appendPlan(steps);
    closePreview();
    set.statusNote(
      `Plan has ${next.length} step${next.length === 1 ? "" : "s"}. Click another target or run the route.`,
    );
  };

  const undoPlan = () => {
    if (refs.moving.current) return;
    const next = refs.plan.current.slice(0, -1);
    refs.plan.current = next;
    const state = stateForPlan(next);
    if (state) refs.planState.current = state;
    set.plan(next);
    closePreview();
    set.statusNote(
      next.length === 0
        ? "Route cleared."
        : `Plan has ${next.length} step${next.length === 1 ? "" : "s"}.`,
    );
  };

  const clearPlan = () => {
    if (refs.moving.current) return;
    refs.plan.current = [];
    const state = stateForPlan([]);
    if (state) refs.planState.current = state;
    set.plan([]);
    closePreview();
    set.statusNote("Route cleared.");
  };

  const pauseAndClearRoute = () => {
    refs.plan.current = [];
    set.plan([]);
    closePreview();
    const state = stateForPlan([]);
    if (state) refs.planState.current = state;
    const next = !refs.paused.current;
    refs.paused.current = next;
    set.paused(next);
    set.toast(next ? "Paused. Route cleared." : "Resumed. Route cleared.");
    set.statusNote(
      next ? "Paused. Set a new route when ready." : "Resumed. Set a new route.",
    );
  };

  const refreshAfterAction = () => {
    const quest = refs.quest.current;
    if (!quest) return;
    const at = refs.player.current;
    const nextRoom = nearbyRoom(quest, at);
    refs.room.current = nextRoom.name;
    set.playerRoom(nextRoom.name);
    const graph = refs.nav.current;
    if (graph) {
      const node = nearestNode(graph, at, 3.0);
      if (node >= 0) set.activeFloor(graph.floor[node]);
    }
    refs.plan.current = [];
    set.plan([]);
    closePreview();
    const state = stateForPlan([]);
    if (state) refs.planState.current = state;
  };

  const focusRoute = () => {
    const client = refs.client.current;
    const route =
      refs.planPath.current.length > 0
        ? refs.planPath.current
        : refs.preview.current?.points ?? [];
    if (!client || route.length < 2) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = -Infinity;
    for (const [x, y, z] of route) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      maxY = Math.max(maxY, y);
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX, maxZ - minZ, 6);
    const eye: Vec3 = [cx, maxY + Math.max(10, span * 0.9), cz + Math.max(8, span * 0.7)];
    const target: Vec3 = [cx, maxY - 0.4, cz];
    const distance = distance3(eye, target);
    const yaw = Math.atan2(eye[0] - target[0], eye[2] - target[2]);
    const pitch = Math.asin((eye[1] - target[1]) / distance);
    client.setOrbit(
      target[0],
      target[1],
      target[2],
      yaw,
      pitch,
      distance,
    );
    set.toast("Framed the route.");
  };

  return {
    previewTarget,
    commitChoice,
    undoPlan,
    clearPlan,
    pauseAndClearRoute,
    dismissPreview,
    closePreview,
    refreshAfterAction,
    focusRoute,
  };
}

