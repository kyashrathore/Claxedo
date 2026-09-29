export type Point = [number, number]

/** The one kolam the hero ships: grid size, mirror density and seed. */
export const heroKolam = { columns: 15, rows: 7, share: 0.6, seed: 5, unit: 28 } as const

/** No closed walk is longer than this: every gap point on the grid is visited at most twice. */
export const maxWalkSteps = (columns: number, rows: number) => 4 * (2 * columns + 1) * (2 * rows + 1)

/**
 * Walks a Gerdes mirror curve on a grid of `columns` × `rows` dots. Dots sit at
 * odd coordinates; the line moves diagonally through the gaps between dots,
 * bounces off the border, and bounces off every mirror it meets.
 */
export function mirrorCurve(columns: number, rows: number, mirrors: ReadonlySet<string>) {
  const width = 2 * columns
  const height = 2 * rows
  const walk: { at: Point; into: Point; out: Point }[] = []
  let [x, y, dx, dy] = [1, 0, 1, 1]
  let into: Point = [1, -1]
  for (let step = 0; step < maxWalkSteps(columns, rows); step++) {
    walk.push({ at: [x, y], into, out: [dx, dy] })
    into = [dx, dy]
    x += dx
    y += dy
    if (x === 0 || x === width) dx = -dx
    if (y === 0 || y === height) dy = -dy
    if (mirrors.has(`${x},${y}`)) {
      if (x % 2 === 0) dy = -dy
      else dx = -dx
    }
    if (x === 1 && y === 0 && dx === 1 && dy === 1) {
      walk[0].into = into
      return walk
    }
  }
  throw new Error(`Kolam walk on ${columns} × ${rows} did not close within ${maxWalkSteps(columns, rows)} steps`)
}

export function isSingleLine(columns: number, rows: number, walk: { at: Point }[]) {
  const width = 2 * columns
  const height = 2 * rows
  let expected = 0
  for (let x = 0; x <= width; x++)
    for (let y = 0; y <= height; y++) {
      if ((x + y) % 2 === 0) continue
      expected += x === 0 || x === width || y === 0 || y === height ? 1 : 2
    }
  return walk.length === expected
}

/** Picks mirrors symmetric about both axes, keeping the kolam one closed line. */
export function symmetricMirrors(columns: number, rows: number, share: number, seed: number) {
  const width = 2 * columns
  const height = 2 * rows
  let state = seed
  const random = () => (state = (state * 16807) % 2147483647) / 2147483647
  const mirrors = new Set<string>()
  for (let x = 1; x <= columns; x++)
    for (let y = 1; y <= rows; y++) {
      if ((x + y) % 2 === 0 || random() > share) continue
      const images: Point[] = [[x, y], [width - x, y], [x, height - y], [width - x, height - y]]
      const next = new Set(mirrors)
      for (const [ix, iy] of images) next.add(`${ix},${iy}`)
      if (isSingleLine(columns, rows, mirrorCurve(columns, rows, next))) for (const key of next) mirrors.add(key)
    }
  return mirrors
}

/** The kolam's line as one closed SVG path: straight through crossings, turning smoothly at every bounce. */
export function kolamPath(columns: number, rows: number, mirrors: ReadonlySet<string>, unit: number) {
  const walk = mirrorCurve(columns, rows, mirrors)
  const tangent = ({ into, out }: { into: Point; out: Point }): Point => {
    const [tx, ty] = [into[0] + out[0], into[1] + out[1]]
    const length = Math.hypot(tx, ty)
    return [tx / length, ty / length]
  }
  const reach = 0.62
  const f = (v: number) => (v * unit).toFixed(1)
  return walk.reduce((d, step, i) => {
    const next = walk[(i + 1) % walk.length]
    const [ax, ay] = tangent(step)
    const [bx, by] = tangent(next)
    return `${d}C${f(step.at[0] + ax * reach)} ${f(step.at[1] + ay * reach)} ${f(next.at[0] - bx * reach)} ${f(next.at[1] - by * reach)} ${f(next.at[0])} ${f(next.at[1])}`
  }, `M${f(walk[0].at[0])} ${f(walk[0].at[1])}`) + "Z"
}
