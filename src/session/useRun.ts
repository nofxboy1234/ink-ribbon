import { nextFrame, MOVE_SPEED } from "./scene";
import { nearestNode } from "../nav";
import { DOOR_COLOURS, itemSatisfied, nearbyRoom, pathLength, pointAt } from "../quest";
import type { DoorState, Vec3 } from "../quest";
import type { QuestSession } from "./types";
import type { usePlanner } from "./usePlanner";

type Planner = ReturnType<typeof usePlanner>;

export function useRun(
  session: QuestSession,
  planner: Planner,
  revealItems: (position: Vec3, force?: boolean) => Set<string>,
) {
  const { refs, set } = session;

  const moveAlong = (points: Vec3[], label: string) =>
    new Promise<void>((resolve) => {
      const client = refs.client.current;
      if (!client) {
        resolve();
        return;
      }
      const total = pathLength(points);
      if (total < 0.01) {
        resolve();
        return;
      }
      const duration = Math.max(260, (total / MOVE_SPEED) * 1000);
      let elapsed = 0;
      let last = performance.now();
      const step = (now: number) => {
        if (refs.cancelled.current || refs.cancelRun.current) {
          resolve();
          return;
        }
        if (refs.paused.current) {
          last = now;
          requestAnimationFrame(step);
          return;
        }
        elapsed += now - last;
        last = now;
        const t = Math.min(1, elapsed / duration);
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const position = pointAt(points, total * ease);
        const graph = refs.nav.current;
        if (graph) {
          const node = nearestNode(graph, [position[0], position[1] - 0.45, position[2]], 2.0);
          if (node >= 0) {
            const surface = graph.y[node] + 0.45;
            if (Math.abs(surface - position[1]) < 0.7) position[1] = surface;
          }
        }
        refs.player.current = position;
        client.setPlayerPosition(position[0], position[1], position[2]);
        revealItems(position);
        set.player(position);
        const room = nearbyRoom(refs.quest.current!, position);
        if (room.name !== refs.room.current) {
          refs.room.current = room.name;
          set.playerRoom(room.name);
        }
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          set.player(position);
          const room = nearbyRoom(refs.quest.current!, position);
          refs.room.current = room.name;
          set.playerRoom(room.name);
          set.statusNote(label);
          resolve();
        }
      };
      requestAnimationFrame(step);
    });

  const performPickup = (itemId: string) => {
    const quest = refs.quest.current;
    const client = refs.client.current;
    const item = quest?.items.find((entry) => entry.id === itemId);
    if (!item) return;
    if (!itemSatisfied(item, refs.inventory.current)) {
      set.toast(`Locked: ${item.name} needs ${item.requires.join(" / ")}.`);
      return;
    }
    const nextInventory = new Set(refs.inventory.current);
    nextInventory.add(item.name);
    refs.inventory.current = nextInventory;
    set.inventory(nextInventory);
    const nextPicked = new Set(refs.picked.current);
    nextPicked.add(item.id);
    refs.picked.current = nextPicked;
    set.picked(nextPicked);
    const marker = refs.itemMarkers.current.get(item.id);
    if (marker !== undefined && client) client.markerSetVisible(marker, 0);
    set.toast(`Picked up ${item.name}`);
    set.statusNote(`Picked up ${item.name}.`);
  };

  const useKey = (doorId: string, itemName: string) => {
    const quest = refs.quest.current;
    const client = refs.client.current;
    const door = quest?.doors.find((entry) => entry.id === doorId);
    if (!door) return;
    const nextStates = new Map(refs.doorStates.current);
    nextStates.set(door.id, "unlocked");
    refs.doorStates.current = nextStates;
    set.doorStates(nextStates);
    const marker = refs.doorMarkers.current.get(door.id);
    if (marker !== undefined && client) {
      const colour = DOOR_COLOURS.unlocked;
      client.markerSetColor(marker, colour[0], colour[1], colour[2]);
    }
    if (itemName) {
      const nextInventory = new Set(refs.inventory.current);
      nextInventory.delete(itemName);
      refs.inventory.current = nextInventory;
      set.inventory(nextInventory);
    }
    set.toast(`Unlocked ${door.label}${itemName ? ` with ${itemName}` : ""}.`);
    set.statusNote(`Unlocked ${door.label}. New routes are open.`);
  };

  const runPlan = async () => {
    if (refs.paused.current) return;
    if (refs.moving.current) return;
    const steps = [...refs.plan.current];
    if (steps.length === 0) return;
    refs.cancelRun.current = false;
    planner.closePreview();
    refs.moving.current = true;
    set.moving(true);
    for (const step of steps) {
      while (refs.paused.current && !refs.cancelled.current && !refs.cancelRun.current) {
        await nextFrame();
      }
      if (refs.cancelled.current || refs.cancelRun.current) break;
      if (step.type === "move") {
        await moveAlong(step.points, step.label);
      } else if (step.type === "pickup") {
        performPickup(step.itemId);
      } else {
        useKey(step.doorId, step.itemName);
      }
      await nextFrame();
    }
    const cancelled = refs.cancelled.current || refs.cancelRun.current;
    refs.moving.current = false;
    set.moving(false);
    planner.refreshAfterAction();
    if (!cancelled) set.statusNote("Route complete.");
  };

  const reset = () => {
    const quest = refs.quest.current;
    const client = refs.client.current;
    if (!quest || !client) return;
    set.inventory(new Set());
    refs.inventory.current = new Set();
    set.picked(new Set());
    refs.picked.current = new Set();
    set.discovered(new Set());
    refs.discovered.current = new Set();
    for (const [id, marker] of refs.itemMarkers.current) {
      const item = quest.items.find((entry) => entry.id === id);
      if (item) client.markerSetVisible(marker, 0);
    }
    const states = new Map<string, DoorState>();
    for (const door of quest.doors) {
      states.set(door.id, door.state);
      const marker = refs.doorMarkers.current.get(door.id);
      if (marker !== undefined) {
        const colour = DOOR_COLOURS[door.state];
        client.markerSetColor(marker, colour[0], colour[1], colour[2]);
      }
    }
    refs.doorStates.current = states;
    set.doorStates(states);
    set.player(quest.spawn);
    refs.player.current = quest.spawn;
    const room = nearbyRoom(quest, quest.spawn);
    refs.room.current = room.name;
    set.playerRoom(room.name);
    set.activeFloor(room.floor);
    client.setPlayerPosition(quest.spawn[0], quest.spawn[1], quest.spawn[2]);
    revealItems(quest.spawn, true);
    planner.refreshAfterAction();
    set.toast("Run reset.");
    set.statusNote("Claire is back at the main hall. Open the 2D plan to plot a new route.");
  };

  return { runPlan, reset };
}
