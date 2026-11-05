import { useEffect } from "react";
import type { NavFile } from "../nav";
import { buildNavGraph, nearestNode } from "../nav";
import { DOOR_COLOURS, DOOR_SHAPE, SHAPES, itemRadius, nearbyRoom } from "../quest";
import type { DoorState, Quest, Vec3 } from "../quest";
import { createRpdClient } from "../wasm/client";
import type { RpdClient } from "../wasm/client";
import { CACHE_VERSION, fetchScene, nextFrame } from "./scene";
import type { QuestSession } from "./types";

export function useSceneLoader(
  session: QuestSession,
  assetUrl: string,
  revealItems: (position: Vec3, force?: boolean) => Set<string>,
) {
  const { refs, set, ref } = session;

  useEffect(() => {
    const controller = new AbortController();
    refs.cancelled.current = false;
    const boot = async () => {
      try {
        const canvas = ref.canvas.current;
        if (!canvas) return;
        const probe = document.createElement("canvas");
        if (!probe.getContext("webgl2")) {
          throw new Error("this browser does not provide WebGL2");
        }
        let version = CACHE_VERSION;
        try {
          const manifest = await fetch(`/rpd/version.json?t=${Date.now()}`, {
            signal: controller.signal,
            cache: "no-store",
          });
          if (manifest.ok) {
            const parsed = (await manifest.json()) as { version?: string };
            if (parsed.version) version = parsed.version;
          }
        } catch {
          // fall back to the bundled cache key
        }
        const versionQuery = `${assetUrl.includes("?") ? "&" : "?"}v=${version}`;
        const [asset, questResponse, navResponse, client] = await Promise.all([
          fetchScene(`${assetUrl}${versionQuery}`, controller.signal, (fraction) => {
            if (!refs.cancelled.current) set.progress(fraction);
          }),
          fetch(`/rpd/quest.json?v=${version}`, {
            signal: controller.signal,
            cache: "no-store",
          }).then((response) => {
            if (!response.ok) throw new Error("could not load the quest data");
            return response.json() as Promise<Quest>;
          }),
          fetch(`/rpd/nav.json?v=${version}`, {
            signal: controller.signal,
            cache: "no-store",
          }).then((response) => {
            if (!response.ok) throw new Error("could not load the navigation graph");
            return response.json() as Promise<NavFile>;
          }),
          createRpdClient({
            canvas,
            locateFile: (path: string) => `/rpd/${path}?v=${version}`,
          }),
        ]);
        if (refs.cancelled.current) {
          client.dispose();
          return;
        }
        refs.client.current = client;
        if (import.meta.env.DEV) {
          (window as unknown as { __rpd?: RpdClient }).__rpd = client;
        }

        const result = client.loadScene(asset);
        if (result !== 0) throw new Error("the RPD scene could not be loaded");

        await nextFrame();
        await nextFrame();

        const graph = buildNavGraph(navResponse);
        refs.nav.current = graph;
        set.nav(graph);
        const spawnNode = nearestNode(graph, questResponse.spawn, 8.0);
        const spawn: Vec3 =
          spawnNode >= 0
            ? [graph.x[spawnNode], graph.y[spawnNode], graph.z[spawnNode]]
            : questResponse.spawn;
        const questData: Quest = { ...questResponse, spawn };

        client.markerClear();
        refs.playerMarker.current = client.markerAdd(
          SHAPES.capsule,
          spawn[0],
          spawn[1],
          spawn[2],
          1.7,
          255,
          121,
          198,
        );
        client.setPlayerPosition(spawn[0], spawn[1], spawn[2]);
        refs.quest.current = questData;
        set.quest(questData);
        set.player(spawn);
        refs.player.current = spawn;
        const spawnRoom = nearbyRoom(questData, spawn);
        set.playerRoom(spawnRoom.name);
        refs.room.current = spawnRoom.name;
        set.activeFloor(spawnNode >= 0 ? graph.floor[spawnNode] : spawnRoom.floor);
        const initialStates = new Map<string, DoorState>();
        for (const door of questData.doors) initialStates.set(door.id, door.state);
        refs.doorStates.current = initialStates;
        set.doorStates(initialStates);
        set.hidden(true);
        revealItems(spawn, true);

        // Mirror the live view into the URL so a pose can be reopened or sent.
        let last = "";
        const syncCamera = () => {
          if (refs.cancelled.current) return;
          const view = client.getCamera();
          const text = [view[0], view[1], view[2], view[3], view[4]]
            .map((value) => (Math.round(value * 100) / 100).toString())
            .join(",");
          if (text !== last) {
            last = text;
            const url = `${location.pathname}${location.search}#cam=${text}`;
            history.replaceState(null, "", url);
          }
          window.setTimeout(syncCamera, 250);
        };
        syncCamera();
      } catch (cause) {
        if (refs.cancelled.current || controller.signal.aborted) return;
        console.error(cause);
        set.error(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void boot();
    return () => {
      refs.cancelled.current = true;
      controller.abort();
    };
  }, [assetUrl, revealItems, refs, set]);
}
