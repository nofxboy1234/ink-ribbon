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
  const floorInfo = nav.floors[floor];
  const floorLevel = floorInfo?.level ?? 0;
  const floorLabel = floorInfo?.label ?? `${floor + 1}F`;
  const playerOnFloor = Math.abs(player[1] - floorLevel) < 2.4;
  const playerScreenX = (player[0] - camera.cx) * camera.scale + viewport.width / 2;
  const playerScreenY = (player[2] - camera.cz) * camera.scale + viewport.height / 2;
  const rooms = quest.rooms.filter((room) => {
    if (room.floor !== floor) return false;
    if (!playerOnFloor) return true;
    const x = (room.x - camera.cx) * camera.scale + viewport.width / 2;
    const y = (room.z - camera.cz) * camera.scale + viewport.height / 2;
    return Math.hypot(x - playerScreenX, y - playerScreenY) > 36;
  });

  return (
    <div className="rpd-map-labels" aria-hidden="true">
      <div className="rpd-map-title">
        <strong>{floorLabel} · FLOOR PLAN</strong>
        <span>wheel to zoom · drag to pan</span>
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
        <span className="rpd-map-player" style={{ left: playerScreenX, top: playerScreenY }}>
          CLAIRE
        </span>
      )}
    </div>
  );
}
