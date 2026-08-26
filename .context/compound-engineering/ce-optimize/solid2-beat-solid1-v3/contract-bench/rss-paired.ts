#!/usr/bin/env bun
// Paired retained-memory benchmark at CONTRACT scale.
//
// Measures post-GC retained JS heap before/after N warm switches between the two
// largest corpus sessions, driving the harness's own launcher + materializer +
// measureSessionActivation (real backend, real 128MiB transcripts, real
// rail-click activation). Run it once per arm and compare.
//
//   bun rss-paired.ts <appRoot> <label> [switches]
//
// e.g.
//   bun rss-paired.ts /home/user/Claxedo/packages/claxedo-app candidate 30
//   bun rss-paired.ts /home/user/claxedo-solid1/packages/claxedo-app control 30
//
// Run from inside <appRoot>/perf-harness so the harness's deps resolve, and
// under a subreaper init (see subreaper.py) — this container's PID 1 reaps
// orphans in ~1.3s while the harness allows 100ms, which otherwise fails
// shutdown with "left a surviving process".
//
// Prereqs: AGENT_APP_BENCHMARK_ROOT corpus generated + digest-verified, both
// arms' dist-local built with VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:41593,
// and the backend artifacts present. PLAYWRIGHT_BROWSERS_PATH must point at a
// Chromium matching the harness's playwright-core pin.
import path from "node:path"
import { mkdir, rm, readFile } from "node:fs/promises"

const APP_ROOT = process.argv[2]
const LABEL = process.argv[3] ?? "arm"
const N = Number(process.argv[4] ?? 30)
if (!APP_ROOT) throw new Error("usage: bun rss-paired.ts <appRoot> <label> [switches]")

const { materializeClaxedoPublicCorpus } = await import(
  path.join(APP_ROOT, "perf-harness/src/public-corpus-materializer.ts")
)
const { launchClaxedoWeb } = await import(path.join(APP_ROOT, "perf-harness/src/agent-claxedo-web-launcher.ts"))
const { measureSessionActivation } = await import(path.join(APP_ROOT, "perf-harness/src/agent-browser-observer.ts"))

const SCRATCH = process.env.RSS_SCRATCH ?? `/tmp/claxedo-rss-${LABEL}`
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
const pair = targets.sort((a: any, b: any) => sizeOf(b) - sizeOf(a)).slice(0, 2)

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

/** Post-GC retained JS heap in MiB. Collect repeatedly — one pass leaves floaters. */
const heap = async () => {
  for (let i = 0; i < 3; i++) await page.rawCommand("HeapProfiler.collectGarbage", {}).catch(() => {})
  await new Promise((r) => setTimeout(r, 400))
  const used = await page.evaluate(() => (performance as any).memory?.usedJSHeapSize ?? 0)
  return used / 1048576
}

// Warm both sessions first so the measurement covers steady-state switching,
// not first-mount allocation.
for (const t of pair) await measureSessionActivation(page, t)
for (const t of pair) await measureSessionActivation(page, t)

const before = await heap()
for (let i = 0; i < N; i++) await measureSessionActivation(page, pair[i % 2])
const after = await heap()

console.log(
  `[${LABEL}] retained JS heap: before ${before.toFixed(1)} MiB -> after ${after.toFixed(1)} MiB | ` +
    `growth ${(after - before).toFixed(1)} MiB over ${N} warm switches ` +
    `(${(((after - before) / N) * 1024).toFixed(0)} KiB/switch)`,
)

await launch.shutdown()
process.exit(0)
