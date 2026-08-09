export type ChartPoint = { x: number; y: number }

// Shape-preserving cubic interpolation keeps measured data from dipping below
// zero or inventing peaks between samples. Usage and Diagnostics share this
// geometry so their charts move and render with the same visual grammar.
function monotoneTangents(points: ChartPoint[]) {
  if (points.length < 2) return [0]
  const slopes = points.slice(0, -1).map((point, index) => {
    const next = points[index + 1]!
    return (next.y - point.y) / Math.max(Number.EPSILON, next.x - point.x)
  })
  const tangents = points.map(() => 0)
  tangents[0] = slopes[0] ?? 0
  tangents[tangents.length - 1] = slopes.at(-1) ?? 0
  for (let index = 1; index < tangents.length - 1; index += 1) {
    const previous = slopes[index - 1] ?? 0
    const next = slopes[index] ?? 0
    tangents[index] = previous * next <= 0 ? 0 : (previous + next) / 2
  }
  for (let index = 0; index < slopes.length; index += 1) {
    const slope = slopes[index]!
    if (slope === 0) {
      tangents[index] = 0
      tangents[index + 1] = 0
      continue
    }
    const a = tangents[index]! / slope
    const b = tangents[index + 1]! / slope
    const magnitude = a * a + b * b
    if (magnitude <= 9) continue
    const scale = 3 / Math.sqrt(magnitude)
    tangents[index] = scale * a * slope
    tangents[index + 1] = scale * b * slope
  }
  return tangents
}

export function monotonePath(points: ChartPoint[]) {
  if (points.length === 0) return ""
  if (points.length === 1) return `M${points[0]!.x},${points[0]!.y}`
  const tangents = monotoneTangents(points)
  return points.slice(0, -1).reduce((path, point, index) => {
    const next = points[index + 1]!
    const dx = next.x - point.x
    return `${path} C${point.x + dx / 3},${point.y + (tangents[index]! * dx) / 3} ${next.x - dx / 3},${next.y - (tangents[index + 1]! * dx) / 3} ${next.x},${next.y}`
  }, `M${points[0]!.x},${points[0]!.y}`)
}
