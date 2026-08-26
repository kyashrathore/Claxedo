#!/usr/bin/env bun
// Paired retained-memory benchmark across MANY DISTINCT sessions.
//
// Why this exists alongside rss-paired.ts: that one alternates two sessions,
// which both stay mounted, so `refs > 0` protects them and the byte-budget
// eviction path never runs. It therefore cannot see changes to eviction policy.
// This variant visits many DISTINCT sessions once each — the scenario the
// SESSION_CACHE_BYTE_BUDGET ceiling actually governs — so cache/eviction work
// shows up in retained heap.
//
//   bun rss-many-sessions.ts <appRoot> <label> [sessionCount]
//
// Same prereqs and subreaper guidance as rss-paired.ts.
import path from "node:path"
import { mkdir, rm, readFile } from "node:fs/promises"

const APP_ROOT = process.argv[2]
const LABEL = process.argv[3] ?? "arm"
const COUNT = Number(process.argv[4] ?? 20)
if (!APP_ROOT) throw new Error("usage: bun rss-many-sessions.ts <appRoot> <label> [sessionCount]")

const { materializeClaxedoPublicCorpus } = await import(
  path.join(APP_ROOT, "perf-harness/src/public-corpus-materializer.ts")
)
const { launchClaxedoWeb } = await import(path.join(APP_ROOT, "perf-harness/src/agent-claxedo-web-launcher.ts"))
const { measureSessionActivation } = await import(path.join(APP_ROOT, "perf-harness/src/agent-browser-observer.ts"))

const SCRATCH = process.env.RSS_SCRATCH ?? `/tmp/claxedo-rssmany-${LABEL}`
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
// Heaviest first: transcript bytes are what the ceiling budgets.
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
await page.rawCommand("HeapProfiler.enable", {}).catch(() => {})

const heap = async () => {
  for (let i = 0; i < 3; i++) await page.rawCommand("HeapProfiler.collectGarbage", {}).catch(() => {})
  await new Promise((r) => setTimeout(r, 400))
  const used = await page.evaluate(() => (performance as any).memory?.usedJSHeapSize ?? 0)
  return used / 1048576
}

// Settle the shell before the baseline so app boot is not counted as growth.
await measureSessionActivation(page, visit[0])
const before = await heap()

let visited = 0
let failed = 0
for (const target of visit) {
  try {
    await measureSessionActivation(page, target)
    visited++
  } catch {
    failed++ // the harness's no-wait rail click can miss; keep going
  }
}
const after = await heap()

const mib = (sizeOf as any) && visit.reduce((total: number, t: any) => total + sizeOf(t), 0) / 1048576
console.log(
  `[${LABEL}] visited ${visited} distinct sessions (${failed} activation failures), ` +
    `~${mib.toFixed(0)} MiB of transcript touched`,
)
console.log(
  `[${LABEL}] retained JS heap: before ${before.toFixed(1)} MiB -> after ${after.toFixed(1)} MiB | ` +
    `growth ${(after - before).toFixed(1)} MiB (${((after - before) / Math.max(1, visited)).toFixed(1)} MiB/session)`,
)

await launch.shutdown()
process.exit(0)
