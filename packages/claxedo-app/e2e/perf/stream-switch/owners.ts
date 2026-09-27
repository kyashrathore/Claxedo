import { readBusyProfile } from "./busy-profile"

const [file, distDir, minMs = "40"] = process.argv.slice(2) as [string, string, string?]
const { parent, busy: long, sourceFile } = readBusyProfile(file, distDir, Number(minMs))

const OWNERS: [string, RegExp][] = [
  ["text-reveal", /ui\/src\/components\/text-reveal\.tsx/],
  ["markdown", /src\/transcript\/markdown(-cache)?\.tsx|marked|dompurify|shiki/],
  ["composer", /src\/composer\//],
  ["transcript parts", /src\/transcript\//],
  ["timeline", /src\/session\/view\/timeline\/|src\/session\/view\/session-timeline\.tsx|tanstack/],
  ["deltas", /src\/session\/transcript\/deltas\.ts|src\/session\/view\/delta-frames\.ts|src\/server\/stream\.ts/],
  ["session screen", /src\/session\/view\/session-screen\.tsx/],
  ["workbench", /src\/workbench\//],
  ["ui kit", /ui\/src\//],
  ["app other", /^src\//],
]

const owners = new Map<number, string>()
const ownerOfFrame = (id: number) => {
  const source = sourceFile(id)
  if (!source) return undefined
  return OWNERS.find(([, pattern]) => pattern.test(source))?.[0]
}
const ownerOf = (leaf: number) => {
  const cached = owners.get(leaf)
  if (cached) return cached
  let owner = "runtime only"
  for (let node: number | undefined = leaf; node !== undefined; node = parent.get(node)) {
    const found = ownerOfFrame(node)
    if (found) {
      owner = found
      break
    }
  }
  owners.set(leaf, owner)
  return owner
}

const totals = new Map<string, number>()
let total = 0
for (const segment of long)
  for (const sample of segment) {
    total += sample.dt
    const owner = ownerOf(sample.id)
    totals.set(owner, (totals.get(owner) ?? 0) + sample.dt)
  }
console.log(`${long.length} busy segments >= ${minMs}ms, ${(total / 1000).toFixed(0)}ms, ${(total / 1000 / long.length).toFixed(1)}ms per segment`)
for (const [owner, us] of [...totals.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`${(us / 1000).toFixed(1).padStart(8)}ms ${(us / 1000 / long.length).toFixed(1).padStart(6)}ms/segment ${((100 * us) / total).toFixed(0).padStart(3)}% ${owner}`)
