import { useEffect } from "react";
import { nearestNode, nearestNodeOnFloor } from "../nav";
import { planPath as buildPlanPath } from "../planner";
import { projectPoint } from "../overlay/geometry";
import { nearbyRoom } from "../quest";
import type { Vec3 } from "../quest";
import type { Target } from "../planner";
import type { QuestSession } from "./types";
import type { usePlanner } from "./usePlanner";
import type { useRun } from "./useRun";

type Planner = ReturnType<typeof usePlanner>;
type Run = ReturnType<typeof useRun>;

export function useDevApi(
  session: QuestSession,
  planner: Planner,
  run: Run,
  pickAt: (clientX: number, clientY: number) => Target | null,
) {
  const { state, refs, set, data, ref } = session;

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const api = {
      plan: state.plan.map((step) => step.label),
      preview: state.preview && {
        label: state.preview.label,
        goalNode: state.preview.goalNode,
        choices: state.preview.choices,
        points: state.preview.points,
      },
      planState: data.planState && {
        inventory: [...data.planState.inventory],
        picked: [...data.planState.picked],
        cursorNode: data.planState.cursorNode,
      },
      debug: () => ({
        player: refs.player.current,
        room: refs.room.current,
        inventory: [...refs.inventory.current],
        discovered: [...refs.discovered.current],
        picked: [...refs.picked.current],
        doors: Object.fromEntries(refs.doorStates.current),
        plan: refs.plan.current.map((step) => step.label),
        moving: refs.moving.current,
        paused: refs.paused.current,
      }),
      previewItem: (id: string) => planner.previewTarget({ kind: "item", id }),
      previewCell: (x: number, z: number) => {
        const graph = refs.nav.current;
        if (!graph) return;
        const floor = graph.floors[refs.activeFloor.current];
        const node = nearestNodeOnFloor(graph, [x, floor?.level ?? 0, z], refs.activeFloor.current, 8);
        if (node >= 0) planner.previewTarget({ kind: "cell", node });
      },
      choose: (index: number) => {
        const current = refs.preview.current;
        const choice = current?.choices[index];
        if (choice) planner.commitChoice(choice);
      },
      run: () => run.runPlan(),
      undo: () => planner.undoPlan(),
      clear: () => planner.clearPlan(),
      setFloor: (floor: number) => {
        refs.activeFloor.current = floor;
        set.activeFloor(floor);
      },
      giveItem: (name: string) => {
        const next = new Set(refs.inventory.current);
        next.add(name);
        refs.inventory.current = next;
        set.inventory(next);
      },
      setPlayer: (x: number, y: number, z: number) => {
        const position: Vec3 = [x, y, z];
        refs.player.current = position;
        set.player(position);
        const quest = refs.quest.current;
        if (quest) set.playerRoom(nearbyRoom(quest, position).name);
        refs.client.current?.setPlayerPosition(x, y, z);
      },
      checkPath: () => {
        const graph = refs.nav.current;
        const points = buildPlanPath(refs.plan.current);
        if (!graph) return null;
        let bad = 0;
        let worst = 0;
        for (const p of points) {
          const node = nearestNode(graph, [p[0], p[1] - 0.45, p[2]], 2.0);
          if (node < 0) {
            bad += 1;
            worst = 99;
            continue;
          }
          const distance = Math.hypot(graph.x[node] - p[0], graph.z[node] - p[2], graph.y[node] + 0.45 - p[1]);
          worst = Math.max(worst, distance);
          if (distance > 0.85) bad += 1;
        }
        return { points: points.length, bad, worst, nodes: graph.count, edges: graph.edgeCount };
      },
      click: (x: number, y: number) => {
        const target = pickAt(x, y);
        if (target) planner.previewTarget(target);
        else planner.dismissPreview();
      },
      matrix: () => Array.from(refs.viewProj.current),
      project: (x: number, y: number, z: number) => {
        const canvas = ref.overlay.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        return projectPoint([x, y, z], refs.viewProj.current, rect.width, rect.height);
      },
    };
    (window as unknown as { __quest?: typeof api }).__quest = api;
    return () => {
      delete (window as unknown as { __quest?: typeof api }).__quest;
    };
  }, [state.quest, state.plan, state.preview, data.planState, state.moving, state.paused]);
}
