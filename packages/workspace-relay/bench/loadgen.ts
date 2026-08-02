#!/usr/bin/env bun
// Loadgen for the Cloudflare-relay re-evaluation bench. Opens N direct + N
// relayed HTTP/WS pairs against a target, measures the same metric set as the
// original June Cloudflare-relay evaluation (HTTP/WS p99 overhead vs direct,
// relayed vs direct WS delivery, connect p95, upstream-open p95, holder setup,
// upstream failure codes), and emits a JSON artifact plus a markdown row.
// Direct and relayed are always measured in the same run window so
// provider/network variance cancels.
//
// The relay is exercised through its real workspace routes
// (/workspaces/<id>/...) with a real Runtime Access Token — no relay code path
// is stubbed. Only the RAT issuer (bench identity) and the target-resolution
// resolver are bench-provided, mirroring how the control plane would supply
// them in production.
//
// Usage (see bench/RUNBOOK.md for full phase recipes):
//   bun bench/loadgen.ts \
//     --relay ws://127.0.0.1:7777 --relay-http http://127.0.0.1:7777 \
//     --direct-ws ws://127.0.0.1:9001 --direct-http http://127.0.0.1:9001 \
//     --workspace ws_bench --path /api/claxedo/pty/pty_1/connect \
//     --connections 20 --concurrency 20 --ws-messages 4 --http-requests 20 \
//     --row-id local-smoke --shape "c20/load20" --trace --out bench/reports

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import { benchIdentityFromPrivatePem, createBenchIdentity, type BenchIdentity } from "./lib/tokens"
import { probeWebSocket, type WsProbeResult } from "./lib/ws"
import {
  evaluateGates,
  markdownRow,
  MARKDOWN_HEADER,
  overheadMs,
  percentile,
  round2,
  shapeLabel,
  type RowMetrics,
} from "./lib/stats"

export type LoadgenConfig = {
  rowId: string
  shape: string
  // ws:// base of the relay, e.g. ws://host:7777 (workspace path appended).
  relayWsUrl: string
  // http:// base of the relay for HTTP-overhead probes.
  relayHttpUrl: string
  // ws:// base of the target for the DIRECT comparison (bypasses the relay).
  directWsUrl: string
  // http:// base of the target for the DIRECT HTTP comparison.
  directHttpUrl: string
  workspaceId: string
  // Path appended after the target base / after /workspaces/<id> on the relay.
  wsPath: string
  httpPath: string
  // Total WS holder connections to open (per direct and per relayed).
  connections: number
  // Max concurrent connection ATTEMPTS. Equal to connections = full burst.
  // Lower than connections = paced opens (H1 mechanism probe).
  concurrency: number
  wsMessagesPerConnection: number
  wsMessageBytes: number
  httpRequests: number
  httpConcurrency: number
  requestTrace: boolean
  openTimeoutMs: number
  messageTimeoutMs: number
  // Extra header the relay forwards to select the RAT-carrying auth style.
  // "subprotocol" (default) uses claxedo-rat.<token>; "header" uses Bearer.
  ratStyle: "subprotocol" | "header"
  // Origin header sent on relayed WS upgrades to satisfy the Bun relay's
  // allowlist (localhost/127.0.0.1 with a port, or *.opencode.ai).
  relayOrigin: string
  // Cloud path: PKCS8 private-key PEM (file path or PEM text) whose PUBLIC half
  // the deployed relay trusts via CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM.
  // When set, RATs are minted from it instead of a throwaway identity — so the
  // loadgen and the deployed relay agree on the signing key. Ignored when
  // `identity` is passed directly (local in-process gates).
  ratPrivateKeyPem?: string
  identity?: BenchIdentity
}

const DEFAULT_CONFIG: Omit<LoadgenConfig, "rowId" | "shape" | "relayWsUrl" | "relayHttpUrl" | "directWsUrl" | "directHttpUrl"> = {
  workspaceId: "ws_bench",
  wsPath: "/api/claxedo/pty/pty_1/connect",
  httpPath: "/api/wr/health",
  connections: 20,
  concurrency: 20,
  wsMessagesPerConnection: 4,
  wsMessageBytes: 64,
  httpRequests: 20,
  httpConcurrency: 20,
  requestTrace: true,
  openTimeoutMs: 30_000,
  messageTimeoutMs: 30_000,
  ratStyle: "subprotocol",
  relayOrigin: "http://localhost:5173",
}

/** Run an async task factory over `total` items with a bounded worker pool. */
async function pooled<T>(total: number, limit: number, task: (index: number) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(total)
  let next = 0
  const worker = async () => {
    for (;;) {
      const index = next++
      if (index >= total) return
      results[index] = await task(index)
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, total)) }, worker)
  await Promise.all(workers)
  return results
}

type HttpSample = { ok: boolean; ms: number; status: number }

async function httpProbe(url: string, headers: Record<string, string>): Promise<HttpSample> {
  const startedAt = performance.now()
  try {
    const res = await fetch(url, { headers })
    await res.arrayBuffer()
    return { ok: res.ok, ms: performance.now() - startedAt, status: res.status }
  } catch {
    return { ok: false, ms: performance.now() - startedAt, status: 0 }
  }
}

async function runHttpPhase(config: LoadgenConfig, rat: string) {
  const directUrl = `${config.directHttpUrl.replace(/\/+$/, "")}${config.httpPath}`
  const relayUrl = `${config.relayHttpUrl.replace(/\/+$/, "")}/workspaces/${config.workspaceId}${config.httpPath}`
  const direct = await pooled(config.httpRequests, config.httpConcurrency, () => httpProbe(directUrl, {}))
  const relayed = await pooled(config.httpRequests, config.httpConcurrency, () =>
    httpProbe(relayUrl, { authorization: `Bearer ${rat}` }),
  )
  return { direct, relayed }
}

function wsProbeOptions(config: LoadgenConfig, url: string, rat?: string) {
  const headers: Record<string, string> = {}
  const protocols: string[] = []
  if (rat) {
    if (config.ratStyle === "header") headers.authorization = `Bearer ${rat}`
    else protocols.push(`claxedo-rat.${rat}`)
    // The Bun relay gates WS upgrades on an allowed Origin
    // (requireAllowedOrigin in src/bun.ts); real browser clients always send
    // one. localhost/127.0.0.1 with any port and *.opencode.ai are allowed.
    // Harmless for the CF relay, which does not gate on Origin.
    headers.origin = config.relayOrigin
  }
  if (rat && config.requestTrace) headers["x-claxedo-relay-ws-trace"] = "1"
  return {
    url,
    messages: config.wsMessagesPerConnection,
    messageBytes: config.wsMessageBytes,
    ...(protocols.length ? { protocols } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    requestTrace: config.requestTrace,
    openTimeoutMs: config.openTimeoutMs,
    messageTimeoutMs: config.messageTimeoutMs,
  }
}

async function runWsPhase(config: LoadgenConfig, rat: string) {
  const directUrl = `${config.directWsUrl.replace(/\/+$/, "")}${config.wsPath}`
  const relayUrl = `${config.relayWsUrl.replace(/\/+$/, "")}/workspaces/${config.workspaceId}${config.wsPath}`
  const direct = await pooled(config.connections, config.concurrency, () =>
    probeWebSocket(wsProbeOptions(config, directUrl)),
  )
  const relayed = await pooled(config.connections, config.concurrency, () =>
    probeWebSocket(wsProbeOptions(config, relayUrl, rat)),
  )
  return { direct, relayed }
}

function tallyDelivery(probes: WsProbeResult[]) {
  let attempted = 0
  let delivered = 0
  for (const probe of probes) {
    attempted += probe.sent
    delivered += probe.delivered
  }
  return { attempted, delivered }
}

function tallyHolders(probes: WsProbeResult[]) {
  return { attempted: probes.length, delivered: probes.filter((p) => p.connected).length }
}

function tallyFailureCodes(probes: WsProbeResult[]): Record<string, number> {
  const codes: Record<string, number> = {}
  for (const probe of probes) {
    if (probe.failureCode) codes[probe.failureCode] = (codes[probe.failureCode] ?? 0) + 1
  }
  return codes
}

/**
 * Tally the close REASONS behind the codes. A code says a connection died; the
 * reason names the guard that killed it, which is the difference between a
 * report you can act on and one you have to instrument to understand.
 */
function tallyFailureReasons(probes: WsProbeResult[]): Record<string, number> {
  const reasons: Record<string, number> = {}
  for (const probe of probes) {
    if (probe.failureReason) reasons[probe.failureReason] = (reasons[probe.failureReason] ?? 0) + 1
  }
  return reasons
}

function flatRtts(probes: WsProbeResult[]): number[] {
  return probes.flatMap((p) => p.rtts)
}

async function resolveIdentity(config: LoadgenConfig): Promise<BenchIdentity> {
  if (config.identity) return config.identity
  if (config.ratPrivateKeyPem) {
    const pem = config.ratPrivateKeyPem.includes("BEGIN")
      ? config.ratPrivateKeyPem.replaceAll("\\n", "\n")
      : await readFile(config.ratPrivateKeyPem, "utf8")
    return benchIdentityFromPrivatePem(pem, { workspaceId: config.workspaceId })
  }
  return createBenchIdentity({ workspaceId: config.workspaceId })
}

export async function runRow(config: LoadgenConfig): Promise<RowMetrics> {
  const identity = await resolveIdentity(config)
  const rat = await identity.mintRat({ workspaceId: config.workspaceId })

  const http = await runHttpPhase(config, rat)
  const ws = await runWsPhase(config, rat)

  const directRtts = flatRtts(ws.direct)
  const relayedRtts = flatRtts(ws.relayed)
  const relayedConnects = ws.relayed.filter((p) => p.connected).map((p) => p.connectMs)
  const traceOpens = ws.relayed.map((p) => p.trace?.wsUpstreamOpenMs).filter((v): v is number => typeof v === "number")

  const upstreamOpenSource: RowMetrics["upstreamOpenSource"] = traceOpens.length > 0 ? "relay-trace" : "client-wall-clock"
  const upstreamOpenP95Ms = round2(
    traceOpens.length > 0 ? percentile(traceOpens, 95) : percentile(relayedConnects, 95),
  )

  const httpDirectOk = http.direct.filter((s) => s.ok).map((s) => s.ms)
  const httpRelayedOk = http.relayed.filter((s) => s.ok).map((s) => s.ms)

  const trace = traceOpens.length > 0
    ? {
        wsUpstreamOpenP95Ms: round2(percentile(traceOpens, 95)),
        maxQueuedFrames: Math.max(0, ...ws.relayed.map((p) => p.trace?.queuedFrames ?? 0)),
        maxQueuedDelayMs: round2(Math.max(0, ...ws.relayed.map((p) => p.trace?.maxQueuedDelayMs ?? 0))),
        samples: traceOpens.length,
      }
    : undefined

  const base: Omit<RowMetrics, "gates"> = {
    rowId: config.rowId,
    shape: config.shape,
    target: config.directHttpUrl,
    relay: config.relayHttpUrl,
    httpP99OverheadMs: overheadMs(httpRelayedOk, httpDirectOk, 99),
    wsMessageP99OverheadMs: overheadMs(relayedRtts, directRtts, 99),
    relayedWsMessages: tallyDelivery(ws.relayed),
    directWsMessages: tallyDelivery(ws.direct),
    connectP95Ms: round2(percentile(relayedConnects, 95)),
    upstreamOpenP95Ms,
    upstreamOpenSource,
    holderSetup: tallyHolders(ws.relayed),
    upstreamFailureCodes: tallyFailureCodes(ws.relayed),
    upstreamFailureReasons: tallyFailureReasons(ws.relayed),
    ...(trace ? { trace } : {}),
  }
  return { ...base, gates: evaluateGates(base) }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { config: LoadgenConfig; outDir?: string } {
  const map = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith("--")) continue
    const key = arg.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith("--")) {
      flags.add(key)
    } else {
      map.set(key, value)
      i++
    }
  }
  const num = (key: string, fallback: number) => (map.has(key) ? Number(map.get(key)) : fallback)
  const str = (key: string, fallback: string) => map.get(key) ?? fallback
  const require = (key: string) => {
    const value = map.get(key)
    if (!value) {
      console.error(`loadgen: missing required --${key}`)
      process.exit(2)
    }
    return value
  }
  const connections = num("connections", DEFAULT_CONFIG.connections)
  const wsMessagesPerConnection = num("ws-messages", DEFAULT_CONFIG.wsMessagesPerConnection)
  const config: LoadgenConfig = {
    rowId: str("row-id", `row-${Date.now()}`),
    shape: str(
      "shape",
      shapeLabel({ concurrency: num("concurrency", connections), wsMessagesPerConnection, connections }),
    ),
    relayWsUrl: require("relay"),
    relayHttpUrl: str("relay-http", require("relay").replace(/^ws/, "http")),
    directWsUrl: require("direct-ws"),
    directHttpUrl: str("direct-http", require("direct-ws").replace(/^ws/, "http")),
    workspaceId: str("workspace", DEFAULT_CONFIG.workspaceId),
    wsPath: str("path", DEFAULT_CONFIG.wsPath),
    httpPath: str("http-path", DEFAULT_CONFIG.httpPath),
    connections,
    concurrency: num("concurrency", connections),
    wsMessagesPerConnection,
    wsMessageBytes: num("ws-message-bytes", DEFAULT_CONFIG.wsMessageBytes),
    httpRequests: num("http-requests", DEFAULT_CONFIG.httpRequests),
    httpConcurrency: num("http-concurrency", num("concurrency", connections)),
    requestTrace: flags.has("trace") || map.get("trace") === "1",
    openTimeoutMs: num("open-timeout-ms", DEFAULT_CONFIG.openTimeoutMs),
    messageTimeoutMs: num("message-timeout-ms", DEFAULT_CONFIG.messageTimeoutMs),
    ratStyle: (str("rat-style", DEFAULT_CONFIG.ratStyle) as LoadgenConfig["ratStyle"]),
    relayOrigin: str("relay-origin", DEFAULT_CONFIG.relayOrigin),
    ...(map.has("rat-private-key-pem") ? { ratPrivateKeyPem: map.get("rat-private-key-pem")! } : {}),
  }
  return { config, ...(map.has("out") ? { outDir: map.get("out") } : {}) }
}

export async function writeReport(row: RowMetrics, outDir: string): Promise<{ jsonPath: string; mdPath: string }> {
  await mkdir(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const base = `${row.rowId}-${stamp}`
  const jsonPath = join(outDir, `${base}.json`)
  const mdPath = join(outDir, `${base}.md`)
  await writeFile(jsonPath, JSON.stringify(row, null, 2))
  await writeFile(mdPath, `${MARKDOWN_HEADER}\n| ${markdownRow(row)}\n`)
  return { jsonPath, mdPath }
}

async function main() {
  const { config, outDir } = parseArgs(process.argv.slice(2))
  console.error(`[loadgen] row=${config.rowId} shape=${config.shape} relay=${config.relayHttpUrl} target=${config.directHttpUrl}`)
  const row = await runRow(config)
  console.log(JSON.stringify(row, null, 2))
  console.error(`\n${MARKDOWN_HEADER}\n| ${markdownRow(row)}`)
  if (outDir) {
    const { jsonPath, mdPath } = await writeReport(row, outDir)
    console.error(`[loadgen] wrote ${jsonPath}`)
    console.error(`[loadgen] wrote ${mdPath}`)
  }
  process.exit(row.gates.pass ? 0 : 1)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[loadgen] failed:", err)
    process.exit(2)
  })
}
