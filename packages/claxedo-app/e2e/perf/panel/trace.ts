import fs from "node:fs"
import path from "node:path"
import { SourceMapConsumer } from "../../../../../node_modules/.bun/node_modules/source-map/source-map.js"
import { traceText, type TraceEvent } from "../../harness/trace-events"

export type TaskRow = {
  readonly startMs: number
  readonly durMs: number
  readonly children: readonly string[]
}

export type TraceSummary = {
  readonly windowMs: number
  readonly tasks: readonly TaskRow[]
  readonly totals: Record<string, number>
}

type Mapper = { readonly map: (file: string, line: number, column: number) => string }

export function createSourceMapper(distDir: string): Mapper {
  const consumers = new Map<string, SourceMapConsumer | null>()
  const consumer = (file: string) => {
    if (consumers.has(file)) return consumers.get(file) ?? null
    const mapPath = path.join(distDir, "assets", `${file}.map`)
    let out: SourceMapConsumer | null = null
    if (fs.existsSync(mapPath)) out = new SourceMapConsumer(JSON.parse(fs.readFileSync(mapPath, "utf8")))
    consumers.set(file, out)
    return out
  }
  return {
    map: (file, line, column) => {
      const found = consumer(file)
      if (!found || line < 1) return `${file}:${line}:${column}`
      const original = found.originalPositionFor({ line, column })
      if (!original.source) return `${file}:${line}:${column}`
      const source = original.source.replace(/^.*\/packages\//, "packages/").replace(/^\.\.\/\.\.\//, "")
      return `${source}:${original.line}${original.name ? ` ${original.name}` : ""}`
    },
  }
}

function describe(event: TraceEvent, mapper: Mapper): string {
  const data = event.args?.data ?? {}
  const ms = ((event.dur ?? 0) / 1000).toFixed(1)
  if (event.name === "FunctionCall") {
    const url = (traceText(data.url) ?? "").split("/").pop() ?? ""
    const where = url ? mapper.map(url, Number(data.lineNumber ?? 1), Number(data.columnNumber ?? 1) - 1) : ""
    return `${ms}ms FunctionCall ${traceText(data.functionName) ?? "(anon)"} ${where}`
  }
  if (event.name === "EventDispatch") return `${ms}ms Event:${traceText(data.type) ?? ""}`
  if (event.name === "TimerFire") return `${ms}ms TimerFire`
  if (event.name === "XHRReadyStateChange" || event.name === "XHRLoad") return `${ms}ms ${event.name} ${(traceText(data.url) ?? "").split("?")[0]?.split("/").slice(-2).join("/")}`
  return `${ms}ms ${event.name}`
}

export function summarizeTrace(events: readonly TraceEvent[], mapper: Mapper): TraceSummary {
  const marks = events.filter((event) => event.cat.includes("blink.user_timing"))
  const at = (name: string) => marks.filter((event) => event.name === name).map((event) => event.ts).sort((a, b) => b - a)[0]
  const input = at("rec:input")
  const settled = at("rec:settled") ?? at("rec:ready")
  if (input === undefined || settled === undefined) return { windowMs: 0, tasks: [], totals: {} }
  const start = input - 2000
  const end = settled + 1000
  const inWindow = events.filter((event) => event.ph === "X" && typeof event.dur === "number" && event.ts >= start && event.ts <= end)
  const tasks = inWindow.filter((event) => event.name === "RunTask" && (event.dur ?? 0) >= 3000).sort((a, b) => a.ts - b.ts)
  const rows = tasks.map((task) => {
    const taskEnd = task.ts + (task.dur ?? 0)
    const inside = inWindow.filter((event) => event !== task && event.pid === task.pid && event.tid === task.tid && event.ts >= task.ts && event.ts + (event.dur ?? 0) <= taskEnd && (event.dur ?? 0) >= 500).sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0))
    const direct: TraceEvent[] = []
    for (const event of inside) {
      const parent = direct.at(-1)
      if (parent && event.ts < parent.ts + (parent.dur ?? 0)) continue
      direct.push(event)
    }
    const children = direct.flatMap((child) => {
      const line = describe(child, mapper)
      if (child.name !== "FunctionCall" && child.name !== "EventDispatch" && child.name !== "TimerFire") return [line]
      const childEnd = child.ts + (child.dur ?? 0)
      const nested = inside.filter((event) => event !== child && event.ts >= child.ts && event.ts + (event.dur ?? 0) <= childEnd && (event.dur ?? 0) >= 1000 && ["FunctionCall", "Layout", "UpdateLayoutTree", "Paint", "PrePaint", "HitTest", "ParseHTML", "Microtasks"].includes(event.name))
      const kept: TraceEvent[] = []
      for (const event of nested.sort((a, b) => a.ts - b.ts)) {
        const previous = kept.at(-1)
        if (previous && event.ts < previous.ts + (previous.dur ?? 0)) continue
        kept.push(event)
      }
      return [line, ...kept.slice(0, 8).map((event) => `    ${describe(event, mapper)}`)]
    })
    return { startMs: (task.ts - input) / 1000, durMs: (task.dur ?? 0) / 1000, children }
  })
  const totals: Record<string, number> = {}
  for (const event of inWindow) {
    if (event.ts < input || event.ts > settled) continue
    if (!["Layout", "UpdateLayoutTree", "Paint", "PrePaint", "FunctionCall", "RunTask", "HitTest", "Commit", "Layerize"].includes(event.name)) continue
    totals[event.name] = (totals[event.name] ?? 0) + (event.dur ?? 0) / 1000
  }
  return { windowMs: (settled - input) / 1000, tasks: rows, totals }
}

export type CpuProfile = {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }; children?: number[] }[]
  samples: number[]
  timeDeltas: number[]
}

type ProfileFrame = CpuProfile["nodes"][number]["callFrame"]

export function profileTree(profile: CpuProfile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  return { byId, parent }
}

export function profileFrameSource(mapper: Mapper, frame: ProfileFrame) {
  const file = frame.url.split("/").pop() ?? ""
  return file ? mapper.map(file, frame.lineNumber + 1, frame.columnNumber) : ""
}

export function profileFrameLabel(mapper: Mapper, frame: ProfileFrame) {
  const source = profileFrameSource(mapper, frame)
  return source ? `${frame.functionName || "(anon)"} ${source}` : frame.functionName || "(anon)"
}

export function summarizeProfile(profile: CpuProfile, mapper: Mapper): string[] {
  const { byId, parent } = profileTree(profile)
  const self = new Map<number, number>()
  for (const [index, sample] of profile.samples.entries()) self.set(sample, (self.get(sample) ?? 0) + (profile.timeDeltas[index] ?? 0))
  const skip = new Set(["(idle)", "(program)", "(garbage collector)", "(root)"])
  const name = (node: CpuProfile["nodes"][number]) => profileFrameLabel(mapper, node.callFrame)
  const rows = [...self.entries()].filter(([id]) => !skip.has(byId.get(id)?.callFrame.functionName ?? "")).map(([id, us]) => [byId.get(id)!, us] as const).sort((a, b) => b[1] - a[1]).slice(0, 14)
  const total = [...self.entries()].filter(([id]) => !skip.has(byId.get(id)?.callFrame.functionName ?? "")).reduce((sum, [, us]) => sum + us, 0)
  const stacks = new Map<string, number>()
  for (const [id, us] of self.entries()) {
    const node = byId.get(id)
    if (!node || skip.has(node.callFrame.functionName)) continue
    const chain: string[] = []
    for (let current: number | undefined = id; current !== undefined; current = parent.get(current)) {
      const frame = byId.get(current)
      if (!frame) break
      const file = frame.callFrame.url.split("/").pop() ?? ""
      if (!file || file.startsWith("vendor")) continue
      chain.push(name(frame))
      if (chain.length >= 3) break
    }
    const key = chain.reverse().join(" > ")
    if (key) stacks.set(key, (stacks.get(key) ?? 0) + us)
  }
  const stackRows = [...stacks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  return [`busy ${(total / 1000).toFixed(1)}ms`, ...rows.map(([node, us]) => `${(us / 1000).toFixed(1)}ms ${name(node)}`), "--app stacks--", ...stackRows.map(([key, us]) => `${(us / 1000).toFixed(1)}ms ${key}`)]
}
