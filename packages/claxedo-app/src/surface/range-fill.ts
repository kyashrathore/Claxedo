export function rangeFillPercent(value: number, min: number, max: number): number {
  if (!(max > min)) return 0
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))
}
