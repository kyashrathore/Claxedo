import fs from "node:fs"
import { createSourceMapper, type CpuProfile } from "../panel/trace"

const [file, distDir, minMs = "60"] = process.argv.slice(2) as [string, string, string?]
const profile = JSON.parse(fs.readFileSync(file, "utf8")) as CpuProfile & { startTime: number }
const mapper = createSourceMapper(distDir)
const byId = new Map(profile.nodes.map((node) => [node.id, node]))
const parent = new Map<number, number>()
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
const names = new Map<number, string>()
const name = (id: number) => {
  const cached = names.get(id)
  if (cached) return cached
  const frame = byId.get(id)!.callFrame
  const url = frame.url.split("/").pop() ?? ""
  const label = url ? `${frame.functionName || "(anon)"} ${mapper.map(url, frame.lineNumber + 1, frame.columnNumber)}` : frame.functionName || "(anon)"
  names.set(id, label)
  return label
}
const idle = new Set(["(idle)", "(program)"])
let time = profile.startTime
const samples = profile.samples.map((id, index) => {
  time += profile.timeDeltas[index] ?? 0
  return { id, at: time, dt: profile.timeDeltas[index + 1] ?? 0 }
})
const segments: (typeof samples)[] = []
let current: typeof samples = []
for (const sample of samples) {
  if (idle.has(byId.get(sample.id)!.callFrame.functionName)) {
    if (current.length) segments.push(current)
    current = []
  } else current.push(sample)
}
const long = segments.filter((segment) => (segment.at(-1)!.at - segment[0]!.at) / 1000 >= Number(minMs))
const inclusive = new Map<string, number>()
const self = new Map<string, number>()
let total = 0
for (const segment of long)
  for (const sample of segment) {
    total += sample.dt
    self.set(name(sample.id), (self.get(name(sample.id)) ?? 0) + sample.dt)
    const seen = new Set<string>()
    for (let node: number | undefined = sample.id; node !== undefined; node = parent.get(node)) {
      const label = name(node)
      if (seen.has(label)) continue
      seen.add(label)
      inclusive.set(label, (inclusive.get(label) ?? 0) + sample.dt)
    }
  }
const top = (map: Map<string, number>, count: number) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([label, us]) => `${(us / 1000).toFixed(1).padStart(8)}ms ${(100 * us / total).toFixed(0).padStart(3)}% ${label}`)
console.log(`${long.length} busy segments >= ${minMs}ms: ${long.map((segment) => Math.round((segment.at(-1)!.at - segment[0]!.at) / 1000)).join(" ")}; total ${(total / 1000).toFixed(0)}ms`)
console.log("--inclusive--")
console.log(top(inclusive, Number(process.env.TOP ?? "60")).join("\n"))
console.log("--self--")
console.log(top(self, 25).join("\n"))
