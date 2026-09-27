import fs from "node:fs"
import { createSourceMapper, type CpuProfile } from "../panel/trace"

const [file, distDir, minMs = "40"] = process.argv.slice(2) as [string, string, string?]
const profile = JSON.parse(fs.readFileSync(file, "utf8")) as CpuProfile & { startTime: number }
const mapper = createSourceMapper(distDir)
const byId = new Map(profile.nodes.map((node) => [node.id, node]))
const parent = new Map<number, number>()
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)

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
  const frame = byId.get(id)!.callFrame
  const url = frame.url.split("/").pop() ?? ""
  if (!url) return undefined
  const source = mapper.map(url, frame.lineNumber + 1, frame.columnNumber).split(":")[0]!
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

const idle = new Set(["(idle)", "(program)", "(garbage collector)"])
let time = profile.startTime
const segments: { id: number; dt: number; at: number }[][] = []
let current: { id: number; dt: number; at: number }[] = []
profile.samples.forEach((id, index) => {
  time += profile.timeDeltas[index] ?? 0
  const sample = { id, at: time, dt: profile.timeDeltas[index + 1] ?? 0 }
  if (idle.has(byId.get(id)!.callFrame.functionName)) {
    if (current.length) segments.push(current)
    current = []
  } else current.push(sample)
})
const long = segments.filter((segment) => (segment.at(-1)!.at - segment[0]!.at) / 1000 >= Number(minMs))
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
