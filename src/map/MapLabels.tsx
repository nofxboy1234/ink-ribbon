import type { NavGraph } from "../nav";
import type { Quest, Vec3 } from "../quest";
import type { MapCamera } from "./useMapCamera";

type MapLabelsProps = {
  nav: NavGraph;
  quest: Quest;
  floor: number;
  player: Vec3;
  camera: MapCamera;
  viewport: { width: number; height: number };
};

export function MapLabels({ nav, quest, floor, player, camera, viewport }: MapLabelsProps) {
  const floorLevel = quest.floors[floor]?.level ?? 0;
  const floorLabel = quest.floors[floor]?.label ?? `${floor + 1}F`;
  const floorItems = quest.items.filter((item) => Math.abs(item.y - floorLevel - 0.36) < 0.8);
  const floorDoors = quest.doors.filter((door) => Math.abs(door.y - floorLevel) < 2.5);
  const playerOnFloor = Math.abs(player[1] - floorLevel - 0.9) < 2.2;
  const playerScreenX = (player[0] - camera.cx) * camera.scale + viewport.width / 2;
  const playerScreenY = (player[2] - camera.cz) * camera.scale + viewport.height / 2;
  const rooms = quest.rooms.filter((room) => {
    if (room.floor !== floor) return false;
    if (!playerOnFloor) return true;
    const x = (room.x - camera.cx) * camera.scale + viewport.width / 2;
    const y = (room.z - camera.cz) * camera.scale + viewport.height / 2;
    return Math.hypot(x - playerScreenX, y - playerScreenY) > 36;
  });
  let activeCount = 0;
  for (let i = 0; i < nav.count; i++) if (nav.floor[i] === floor) activeCount += 1;

  return (
    <div className="rpd-map-labels" aria-hidden="true">
      <div className="rpd-map-title">
        <strong>{floorLabel} · SOKOL TOP-DOWN</strong>
        <span>
          {activeCount} cells · {floorItems.length} items · {floorDoors.length} doors · wheel to zoom · drag to pan
        </span>
      </div>
      {rooms.map((room) => (
        <span
          key={room.name}
          className="rpd-map-room"
          style={{
            left: (room.x - camera.cx) * camera.scale + viewport.width / 2,
            top: (room.z - camera.cz) * camera.scale + viewport.height / 2,
          }}
        >
          {room.name}
        </span>
      ))}
      {playerOnFloor && (
        <span
          className="rpd-map-player"
          style={{ left: playerScreenX, top: playerScreenY }}
        >
          CLAIRE
        </span>
      )}
      <div className="rpd-map-legend">
        <span><i style={{ background: "#c28cff" }} />CLAIRE</span>
        <span><i style={{ background: "#43ff74" }} />ROUTE</span>
        <span><i style={{ background: "#ff9d3c" }} />PREVIEW</span>
        <span><i style={{ background: "#22d3ee" }} />WAYPOINT</span>
        <span><i style={{ background: "#1f77b4" }} />DOOR</span>
        <span><i style={{ background: "#43d17a" }} />ITEM</span>
        <span><i style={{ background: "#d6a95c" }} />STAIR</span>
      </div>
      {!playerOnFloor && <div className="rpd-map-note">Claire is on another floor</div>}
    </div>
  );
}
