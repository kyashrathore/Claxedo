#!/usr/bin/env bun
// Measures request SERIALIZATION on the session-switch path.
//
// Reports, per cold switch: request count, network wall (first start -> last
// end), network BUSY (union of in-flight intervals), and the sum of individual
// durations. parallelism = serial-sum / busy: 1.0 means fully serialized, higher
// means requests overlap. Use it to verify "fetch high, block low" changes
// actually overlap requests rather than just moving them around.
//
//   bun net-waterfall.ts <appRoot> <label> [switches]
//
// Same prereqs and subreaper guidance as rss-paired.ts.
import path from "node:path"
import { mkdir, rm, readFile } from "node:fs/promises"

const APP_ROOT = process.argv[2]
const LABEL = process.argv[3] ?? "arm"
const COUNT = Number(process.argv[4] ?? 6)
if (!APP_ROOT) throw new Error("usage: bun net-waterfall.ts <appRoot> <label> [switches]")

const { materializeClaxedoPublicCorpus } = await import(
  path.join(APP_ROOT, "perf-harness/src/public-corpus-materializer.ts")
)
const { launchClaxedoWeb } = await import(path.join(APP_ROOT, "perf-harness/src/agent-claxedo-web-launcher.ts"))
const { measureSessionActivation } = await import(path.join(APP_ROOT, "perf-harness/src/agent-browser-observer.ts"))

const SCRATCH = process.env.NET_SCRATCH ?? `/tmp/claxedo-net-${LABEL}`
const CORPUS =
  process.env.CLAXEDO_CORPUS ?? "/home/user/agent-app-benchmark/artifacts/corpora/opencode-completed-sessions-v3"

await rm(SCRATCH, { recursive: true, force: true })
const data = path.join(SCRATCH, "data")
const profile = path.join(SCRATCH, "profile")
await mkdir(data, { recursive: true, mode: 0o700 })
await mkdir(profile, { recursive: true, mode: 0o700 })

const manifest = JSON.parse(await readFile(path.join(CORPUS, "manifest.json"), "utf8"))
const mat = await materializeClaxedoPublicCorpus({
  corpusDirectory: CORPUS,
  corpusManifestPath: path.join(CORPUS, "manifest.json"),
  expectedCorpusDigestSha256: manifest.corpusDigestSha256,
  expectedEventSchemaDigestSha256: manifest.sourceEventFormat.schemaDigestSha256,
  dataDirectory: data,
  workspaceDirectory: path.join(SCRATCH, "workspaces"),
})

const byLogical = new Map(manifest.sessions.map((s: any) => [s.logicalSessionId, s]))
const targets = [...mat.readinessTargets.values()]
const sizeOf = (t: any) => byLogical.get(t.logicalSessionId)?.transcriptBytes ?? 0
const visit = targets.sort((a: any, b: any) => sizeOf(b) - sizeOf(a)).slice(0, COUNT)

const launch = await launchClaxedoWeb({
  appRoot: APP_ROOT,
  isolatedProfilePath: profile,
  dataDirectory: data,
  readinessTargets: targets,
  serverPort: 41593,
  previewPort: 41444,
  timeoutMs: 180000,
})
const page = launch.page as any

/** Drain PerformanceResourceTiming and summarise overlap since the last call. */
const summarize = async () =>
  page.evaluate(() => {
    const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[]
    performance.clearResourceTimings()
    if (entries.length === 0) return { count: 0, wall: 0, busy: 0, serial: 0, top: [] as any[] }
    const spans = entries.map((e) => [e.startTime, e.responseEnd] as const).sort((a, b) => a[0] - b[0])
    const wall = Math.max(...spans.map((s) => s[1])) - Math.min(...spans.map((s) => s[0]))
    let busy = 0
    let start = spans[0][0]
    let end = spans[0][1]
    for (const [s, e] of spans.slice(1)) {
      if (s > end) {
        busy += end - start
        start = s
        end = e
      } else end = Math.max(end, e)
    }
    busy += end - start
    const serial = spans.reduce((total, [s, e]) => total + (e - s), 0)
    const top = entries
      .map((e) => ({ u: e.name.split("/").slice(-2).join("/").slice(0, 44), d: Math.round(e.duration) }))
      .sort((a, b) => b.d - a.d)
      .slice(0, 6)
    return { count: entries.length, wall: Math.round(wall), busy: Math.round(busy), serial: Math.round(serial), top }
  })

await summarize() // discard boot traffic
const rows: any[] = []
for (const target of visit) {
  let ms = Number.NaN
  try {
    const r = await measureSessionActivation(page, target)
    ms = Math.round(r.durationMs)
  } catch {
    /* harness no-wait rail click can miss; still record the network shape */
  }
  rows.push({ ms, ...(await summarize()) })
}

console.log(`[${LABEL}] per cold switch: duration | reqs | net-wall | net-busy | serial-sum`)
for (const r of rows) {
  console.log(
    `  ${String(r.ms).padStart(5)}ms | ${String(r.count).padStart(3)} reqs | wall ${String(r.wall).padStart(5)} | ` +
      `busy ${String(r.busy).padStart(5)} | serial ${String(r.serial).padStart(6)}  ` +
      `top:${r.top.map((t: any) => `${t.u}:${t.d}`).join(" ")}`,
  )
}
const total = rows.reduce(
  (a, r) => ({
    ms: a.ms + (Number.isFinite(r.ms) ? r.ms : 0),
    count: a.count + r.count,
    busy: a.busy + r.busy,
    serial: a.serial + r.serial,
  }),
  { ms: 0, count: 0, busy: 0, serial: 0 },
)
console.log(
  `[${LABEL}] TOTAL dur ${total.ms}ms | reqs ${total.count} | net-busy ${total.busy}ms | ` +
    `serial-sum ${total.serial}ms | parallelism ${(total.serial / Math.max(1, total.busy)).toFixed(2)}x`,
)

await launch.shutdown()
process.exit(0)
