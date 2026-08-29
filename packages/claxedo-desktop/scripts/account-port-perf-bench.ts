/**
 * AccountPort live-stream performance bench (Arm C — main + IPC-shaped send).
 *
 * What matters for UX: per-event lag under a paced inject, first-byte on connect,
 * and whether the path keeps up (lag does not grow over the run).
 *
 * Batch wall time is NOT a live-stream verdict — draining N events as fast as
 * possible is throughput, not "user watching a live stream."
 *
 * Usage:
 *   bun ./scripts/account-port-perf-bench.ts
 *   bun ./scripts/account-port-perf-bench.ts --live-only
 *   bun ./scripts/account-port-perf-bench.ts --sessions=20 --eps=50 --seconds=5 --bytes=2048
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createAccountService, type RefreshOutcome } from "../src/main/account/account-service"
import { accountPerfForce, accountPerfMark } from "../src/main/account/account-perf"
import type { CredentialStore, TokenSet } from "../src/main/account/credential-store"
import type { OAuthSeams } from "../src/main/account/oauth-flow"

type LiveScenario = {
  sessions: number
  /** Events per second per session (paced inject). */
  eps: number
  seconds: number
  bytes: number
  label?: string
}

type LiveResult = {
  arm: string
  scenario: LiveScenario
  aggregateEps: number
  expectedEvents: number
  receivedEvents: number
  firstByteMs: number[]
  /** Lag = receive time − scheduled inject time (live UX metric). */
  lagMs: number[]
  lagFirstHalfMs: number[]
  lagSecondHalfMs: number[]
  ipcSerializeMsPerEvent: number
  cpuUserMs: number
  cpuSystemMs: number
  rssDeltaMiB: number
  keepsUp: boolean
  valid: boolean
  invalidReasons: string[]
}

function parseFlag(argv: string[], key: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${key}=`))
  return hit ? hit.slice(key.length + 3) : undefined
}

function parseNum(argv: string[], key: string, fallback: number): number {
  const raw = parseFlag(argv, key)
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]!
}

function summarizeMs(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
  }
}

function sampleResources() {
  const mem = process.memoryUsage()
  const cpu = process.cpuUsage()
  return {
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    cpuUserUs: cpu.user,
    cpuSystemUs: cpu.system,
  }
}

function ssePayload(messageIndex: number, bytes: number, scheduledAt: number): string {
  // Embed schedule so lag is measured from the payload, not from fetch/open ordering.
  const meta = `{"i":${messageIndex},"t":${scheduledAt}}`
  const id = `id: ${messageIndex}\n`
  const prefix = "data: "
  const suffix = "\n\n"
  const overhead = id.length + prefix.length + suffix.length + meta.length
  const padLen = Math.max(0, bytes - overhead)
  return `${id}${prefix}${meta}${"x".repeat(padLen)}${suffix}`
}

function parseScheduledAt(text: string): number | undefined {
  const match = /data:\s*\{"i":\d+,"t":([0-9.]+)\}/.exec(text)
  if (!match) return undefined
  const t = Number(match[1])
  return Number.isFinite(t) ? t : undefined
}

/**
 * Paced SSE: each event is scheduled at streamStart + i * intervalMs.
 * Pull waits until the schedule so lag measures handler delay, not inject burst.
 */
function makePacedSseResponse(messages: number, bytes: number, intervalMs: number, streamStart: number): Response {
  const encoder = new TextEncoder()
  let i = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= messages) {
        controller.close()
        return
      }
      const scheduled = streamStart + i * intervalMs
      const wait = scheduled - performance.now()
      if (wait > 0) await Bun.sleep(wait)
      controller.enqueue(encoder.encode(ssePayload(i, bytes, scheduled)))
      i++
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

const TOKENS: TokenSet = { accessToken: "at_bench", refreshToken: "rt_bench", expiresAt: Date.now() + 3_600_000 }

function memoryStore(initial?: TokenSet): CredentialStore {
  let held = initial
  return {
    available: () => ({ usable: true }),
    save: (tokens) => {
      held = tokens
    },
    load: () => held,
    clear: () => {
      held = undefined
    },
  }
}

function buildService(fetchImpl: typeof fetch) {
  const seams: OAuthSeams = {
    openExternal: async () => {},
    listen: async () => ({ port: 49_152, close: async () => {} }),
    exchange: async () => TOKENS,
    safeStorage: () => ({ available: true, platform: "darwin" }),
    setTimeout: () => ({ cancel: () => {} }),
  }
  return createAccountService({
    config: {
      authorizeUrl: "https://accounts.example.com/oauth/authorize",
      tokenUrl: "https://accounts.example.com/oauth/token",
      clientId: "client_desktop",
      scope: "openid",
      timeoutMs: 1_000,
    },
    seams,
    store: memoryStore(TOKENS),
    serverOrigin: "https://control.test",
    now: () => Date.now(),
    fetch: fetchImpl as never,
    refresh: async (): Promise<RefreshOutcome> => ({ ok: true, tokens: TOKENS }),
  })
}

function messagesFor(scenario: LiveScenario): number {
  return Math.max(1, Math.round(scenario.eps * scenario.seconds))
}

function intervalMs(scenario: LiveScenario): number {
  return 1000 / scenario.eps
}

/**
 * Keep-up rule: second-half lag p95 must not exceed first-half p95 by more than
 * one inject interval (backlog not growing). Also lag p95 under 2× interval.
 */
function evaluateKeepsUp(scenario: LiveScenario, firstHalf: number[], secondHalf: number[], all: number[]): boolean {
  const interval = intervalMs(scenario)
  const allP95 = summarizeMs(all).p95
  const firstP95 = summarizeMs(firstHalf).p95
  const secondP95 = summarizeMs(secondHalf).p95
  if (allP95 > interval * 2 + 5) return false
  if (secondP95 > firstP95 + interval) return false
  return true
}

async function runLiveArm(scenario: LiveScenario, arm: "direct" | "accountPort"): Promise<LiveResult> {
  const messages = messagesFor(scenario)
  const interval = intervalMs(scenario)
  const expectedEvents = scenario.sessions * messages
  const firstByteMs: number[] = []
  const lagMs: number[] = []
  const lagFirstHalfMs: number[] = []
  const lagSecondHalfMs: number[] = []
  let receivedEvents = 0
  let ipcSerializeMsTotal = 0
  const invalidReasons: string[] = []
  const half = Math.floor(messages / 2)

  const recordEvent = (text: string, eventIndex: number) => {
    const now = performance.now()
    const scheduled = parseScheduledAt(text)
    const lag = scheduled === undefined ? 0 : Math.max(0, now - scheduled)
    lagMs.push(lag)
    if (eventIndex < half) lagFirstHalfMs.push(lag)
    else lagSecondHalfMs.push(lag)
    receivedEvents++
  }

  const before = sampleResources()

  if (arm === "direct") {
    await Promise.all(
      Array.from({ length: scenario.sessions }, async (_s, sessionIdx) => {
        const openAt = performance.now()
        const streamStart = performance.now()
        let first = true
        let idx = 0
        const response = makePacedSseResponse(messages, scenario.bytes, interval, streamStart)
        if (!response.body) {
          invalidReasons.push(`session ${sessionIdx}: no body`)
          return
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        while (true) {
          const next = await reader.read()
          if (next.done) break
          const text = decoder.decode(next.value, { stream: true })
          if (text.length === 0) continue
          if (first) {
            first = false
            firstByteMs.push(performance.now() - openAt)
          }
          recordEvent(text, idx)
          idx++
        }
      }),
    )
  } else {
    const pacedFetch: typeof fetch = async (url) => {
      const href = String(url)
      if (href.includes("/api/wr/events") || href.includes("/runtime-events")) {
        return makePacedSseResponse(messages, scenario.bytes, interval, performance.now())
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    const service = buildService(pacedFetch)
    service.restore()

    await Promise.all(
      Array.from({ length: scenario.sessions }, async (_s, sessionIdx) => {
        const openAt = performance.now()
        let first = true
        let idx = 0
        let seq = 0
        await service.openStream({
          name: "session.events",
          params: {},
          onChunk: (text) => {
            if (text.length === 0) return
            if (first) {
              first = false
              firstByteMs.push(performance.now() - openAt)
            }
            const serializeStart = performance.now()
            const envelope = JSON.stringify({
              streamId: `stream-${sessionIdx}`,
              text,
              seq: seq++,
              sentAt: performance.now(),
            })
            ipcSerializeMsTotal += performance.now() - serializeStart
            if (envelope.length < 0) throw new Error("unreachable")
            recordEvent(text, idx)
            idx++
          },
        })
      }),
    )
  }

  const after = sampleResources()
  if (receivedEvents !== expectedEvents) {
    invalidReasons.push(`events ${receivedEvents} !== expected ${expectedEvents}`)
  }

  const keepsUp =
    invalidReasons.length === 0 && evaluateKeepsUp(scenario, lagFirstHalfMs, lagSecondHalfMs, lagMs)

  return {
    arm: arm === "direct" ? "B-direct (paced)" : "C-accountPort+ipc-serialize (paced)",
    scenario,
    aggregateEps: scenario.sessions * scenario.eps,
    expectedEvents,
    receivedEvents,
    firstByteMs,
    lagMs,
    lagFirstHalfMs,
    lagSecondHalfMs,
    ipcSerializeMsPerEvent: ipcSerializeMsTotal / Math.max(1, receivedEvents),
    cpuUserMs: (after.cpuUserUs - before.cpuUserUs) / 1000,
    cpuSystemMs: (after.cpuSystemUs - before.cpuSystemUs) / 1000,
    rssDeltaMiB: (after.rssBytes - before.rssBytes) / (1024 * 1024),
    keepsUp,
    valid: invalidReasons.length === 0,
    invalidReasons,
  }
}

function formatLive(result: LiveResult): string {
  const first = summarizeMs(result.firstByteMs)
  const lag = summarizeMs(result.lagMs)
  const lag1 = summarizeMs(result.lagFirstHalfMs)
  const lag2 = summarizeMs(result.lagSecondHalfMs)
  const s = result.scenario
  const label = s.label ?? `${s.sessions} sess × ${s.eps} evt/s × ${s.seconds}s × ${s.bytes}B`
  return [
    `### ${result.arm}`,
    `flow: ${label}`,
    `  → aggregate ${result.aggregateEps} evt/s · ${result.receivedEvents} events`,
    `valid: ${result.valid}${result.invalidReasons.length ? ` (${result.invalidReasons.join("; ")})` : ""}`,
    `keeps up (live): ${result.keepsUp ? "YES" : "NO"}`,
    `event lag (scheduled→handler): p50 ${lag.p50.toFixed(2)} ms · p95 ${lag.p95.toFixed(2)} ms · max ${lag.max.toFixed(2)} ms`,
    `  first-half p95 ${lag1.p95.toFixed(2)} ms → second-half p95 ${lag2.p95.toFixed(2)} ms`,
    `first-byte: p50 ${first.p50.toFixed(2)} ms · p95 ${first.p95.toFixed(2)} ms`,
    `CPU during window: user ${result.cpuUserMs.toFixed(1)} ms · system ${result.cpuSystemMs.toFixed(1)} ms · RSS Δ ${result.rssDeltaMiB.toFixed(2)} MiB`,
    result.ipcSerializeMsPerEvent > 0
      ? `IPC serialize per event: ${result.ipcSerializeMsPerEvent.toFixed(4)} ms`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n")
}

function defaultLadder(bytes: number): LiveScenario[] {
  // Scale concurrency and rate; duration short enough for CI-ish runs but long
  // enough to see lag growth (3–5s).
  return [
    { label: "baseline live", sessions: 20, eps: 10, seconds: 3, bytes },
    { label: "10× aggregate rate", sessions: 20, eps: 100, seconds: 3, bytes },
    { label: "10× sessions", sessions: 200, eps: 10, seconds: 3, bytes },
    { label: "25× aggregate (20×250)", sessions: 20, eps: 250, seconds: 3, bytes },
    { label: "50× aggregate (20×500)", sessions: 20, eps: 500, seconds: 3, bytes },
    { label: "100× aggregate (20×1000)", sessions: 20, eps: 1000, seconds: 3, bytes },
    { label: "100× sessions (200×100)", sessions: 200, eps: 100, seconds: 3, bytes },
  ]
}

async function main() {
  const argv = process.argv.slice(2)
  const bytes = parseNum(argv, "bytes", 2048)
  const liveOnly = argv.includes("--live-only") || !argv.includes("--batch")
  const custom =
    parseFlag(argv, "sessions") || parseFlag(argv, "eps") || parseFlag(argv, "seconds")
      ? [
          {
            sessions: parseNum(argv, "sessions", 20),
            eps: parseNum(argv, "eps", 50),
            seconds: parseNum(argv, "seconds", 3),
            bytes,
            label: "custom",
          } satisfies LiveScenario,
        ]
      : defaultLadder(bytes)

  const outDir = join(process.cwd(), ".artifacts", "account-port-bench", new Date().toISOString().replace(/[:.]/g, "-"))
  mkdirSync(outDir, { recursive: true })
  const markPath = join(outDir, "marks.ndjson")
  accountPerfForce(true, markPath)

  console.log("AccountPort LIVE-STREAM performance bench")
  console.log("(Verdict = event lag + keeps-up, not batch wall)")
  console.log(`artifact dir: ${outDir}`)
  console.log("")

  // Tiny warmup
  await runLiveArm({ sessions: 2, eps: 20, seconds: 0.5, bytes: 512 }, "accountPort")

  accountPerfMark("bench.live.start", { scenarios: custom.length })

  const rows: Array<{ scenario: LiveScenario; direct: LiveResult; account: LiveResult }> = []
  for (const scenario of custom) {
    const direct = await runLiveArm(scenario, "direct")
    const account = await runLiveArm(scenario, "accountPort")
    rows.push({ scenario, direct, account })
  }

  const lines: string[] = [
    "# AccountPort live-stream overhead (Arm C paced inject)",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "Batch wall is omitted as a verdict. Live UX metrics: **event lag** (scheduled inject → handler)",
    "and **keeps up** (lag p95 stable across the run, under ~2× inject interval).",
    "",
  ]

  for (const row of rows) {
    const dLag = summarizeMs(row.direct.lagMs)
    const aLag = summarizeMs(row.account.lagMs)
    const dFirst = summarizeMs(row.direct.firstByteMs)
    const aFirst = summarizeMs(row.account.firstByteMs)
    lines.push(`## ${row.scenario.label ?? "scenario"}`)
    lines.push("")
    lines.push(
      `${row.scenario.sessions} sessions × ${row.scenario.eps} evt/s/session for ${row.scenario.seconds}s (~${row.scenario.bytes} B) = **${row.scenario.sessions * row.scenario.eps} aggregate evt/s**`,
    )
    lines.push("")
    lines.push(formatLive(row.direct))
    lines.push("")
    lines.push(formatLive(row.account))
    lines.push("")
    lines.push("### Live tax (AccountPort − direct)")
    lines.push(
      `event lag p95: ${(aLag.p95 - dLag.p95).toFixed(2)} ms · first-byte p95: ${(aFirst.p95 - dFirst.p95).toFixed(2)} ms`,
    )
    lines.push(
      `keeps up: direct=${row.direct.keepsUp ? "YES" : "NO"} · accountPort=${row.account.keepsUp ? "YES" : "NO"}`,
    )
    lines.push("")
  }

  lines.push("## Notes")
  lines.push("")
  lines.push("- Arm C only (main openStream + IPC JSON envelope). Real Electron `sender.send` + renderer apply not included.")
  lines.push("- `keepsUp=NO` means live stream would feel behind (lag growing or p95 > ~2× inject spacing).")
  lines.push("")

  const report = lines.join("\n")
  writeFileSync(join(outDir, "summary.md"), report)
  writeFileSync(
    join(outDir, "summary.json"),
    JSON.stringify(
      {
        mode: "live",
        rows: rows.map((r) => ({
          scenario: r.scenario,
          direct: { ...r.direct, lag: summarizeMs(r.direct.lagMs), firstByte: summarizeMs(r.direct.firstByteMs) },
          account: {
            ...r.account,
            lag: summarizeMs(r.account.lagMs),
            firstByte: summarizeMs(r.account.firstByteMs),
          },
        })),
      },
      null,
      2,
    ),
  )

  console.log(report)
  console.log(`Wrote ${join(outDir, "summary.md")}`)
  console.log(`Wrote ${join(outDir, "summary.json")}`)

  if (!liveOnly) {
    // reserved: batch mode removed from default verdict path
  }

  const failed = rows.some((r) => !r.direct.valid || !r.account.valid)
  if (failed) process.exitCode = 2
}

await main()
