export type NavCellKind = "floor" | "stair" | "ramp";

export type RGBA = [number, number, number, number];

export const NAV_CELL_SIDE = "rgba(70, 170, 255, 0.22)";
export const NAV_CELL_OTHER = "rgba(151, 205, 255, 0.08)";

export const NAV_CELL_CENTRE: Record<
  NavCellKind,
  { css: string; rgb: readonly [number, number, number] }
> = {
  floor: { css: "rgba(151, 205, 255, 0.42)", rgb: [151, 205, 255] },
  stair: { css: "rgba(240, 196, 116, 0.62)", rgb: [240, 196, 116] },
  ramp: { css: "rgba(125, 211, 252, 0.55)", rgb: [125, 211, 252] },
};

export const NAV_CELL_SIDE_RGBA: RGBA = [70 / 255, 170 / 255, 1, 0.22];

export function navAreaColour(kind: NavCellKind, alpha: number): RGBA {
  const [r, g, b] = NAV_CELL_CENTRE[kind].rgb;
  return [r / 255, g / 255, b / 255, alpha];
}
