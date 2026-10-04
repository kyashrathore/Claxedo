export function clampCoordinate(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}
