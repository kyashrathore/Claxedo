import { readBusyProfile } from "./busy-profile"

const [file, distDir, minMs = "60"] = process.argv.slice(2) as [string, string, string?]
const { parent, busy: long, label: frameLabel, sourceFile } = readBusyProfile(file, distDir, Number(minMs))
const names = new Map<number, string>()
const name = (id: number) => {
  const cached = names.get(id)
  if (cached) return cached
  const text = frameLabel(id)
  names.set(id, text)
  return text
}
const inclusive = new Map<string, number>()
const self = new Map<string, number>()
const byFile = new Map<string, number>()
const fileOf = (id: number) => sourceFile(id) || "(native)"
let total = 0
for (const segment of long)
  for (const sample of segment) {
    total += sample.dt
    self.set(name(sample.id), (self.get(name(sample.id)) ?? 0) + sample.dt)
    const seen = new Set<string>()
    const files = new Set<string>()
    for (let node: number | undefined = sample.id; node !== undefined; node = parent.get(node)) {
      const label = name(node)
      files.add(fileOf(node))
      if (seen.has(label)) continue
      seen.add(label)
      inclusive.set(label, (inclusive.get(label) ?? 0) + sample.dt)
    }
    for (const file of files) byFile.set(file, (byFile.get(file) ?? 0) + sample.dt)
  }
const top = (map: Map<string, number>, count: number) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([label, us]) => `${(us / 1000).toFixed(1).padStart(8)}ms ${(100 * us / total).toFixed(0).padStart(3)}% ${label}`)
console.log(`${long.length} busy segments >= ${minMs}ms: ${long.map((segment) => Math.round((segment.at(-1)!.at - segment[0]!.at) / 1000)).join(" ")}; total ${(total / 1000).toFixed(0)}ms`)
console.log("--inclusive--")
console.log(top(inclusive, Number(process.env.TOP ?? "60")).join("\n"))
console.log("--inclusive by file--")
console.log(top(byFile, Number(process.env.TOP ?? "60")).join("\n"))
console.log("--self--")
console.log(top(self, 25).join("\n"))
