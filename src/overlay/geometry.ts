import type { Vec3 } from "../quest";

export function projectPoint(
  point: Vec3,
  matrix: Float32Array,
  width: number,
  height: number,
): { x: number; y: number; depth: number } | null {
  const [x, y, z] = point;
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (w <= 0.0001) return null;
  const cx = (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w;
  const cy = (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w;
  return {
    x: (cx * 0.5 + 0.5) * width,
    y: (1 - (cy * 0.5 + 0.5)) * height,
    depth: w,
  };
}

export function pointInQuad(
  x: number,
  y: number,
  quad: { x: number; y: number }[],
): boolean {
  let sign = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (Math.abs(cross) < 1e-6) continue;
    const next = Math.sign(cross);
    if (sign === 0) sign = next;
    else if (next !== sign) return false;
  }
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function fanOffset(index: number, count: number): { x: number; y: number } {
  if (count <= 1) return { x: 0, y: -72 };
  if (count === 2) {
    return index === 0 ? { x: -86, y: -66 } : { x: 86, y: -66 };
  }
  if (count === 3) {
    if (index === 0) return { x: -104, y: 0 };
    if (index === 1) return { x: 0, y: -80 };
    return { x: 104, y: 0 };
  }
  const spread = Math.PI * 0.95;
  const angle = -Math.PI / 2 - spread / 2 + (index / (count - 1)) * spread;
  const radius = 98;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius - 8 };
}

export function popupGeometry(
  anchor: { x: number; y: number },
  count: number,
  width: number,
  height: number,
): { x: number; y: number; offsets: { x: number; y: number }[] } {
  const minX = Math.min(170, width / 2);
  const maxX = Math.max(minX, width - 170);
  const minY = Math.min(220, Math.max(90, height - 90));
  const maxY = Math.max(minY, height - 60);
  return {
    x: clamp(anchor.x, minX, maxX),
    y: clamp(anchor.y, minY, maxY),
    offsets: Array.from({ length: count }, (_, index) => fanOffset(index, count)),
  };
}
