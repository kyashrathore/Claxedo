// Opens N direct + N relayed HTTP/WS pairs against one target in the same run
// window, so network variance cancels, and reports relay overhead: HTTP/WS p99
// overhead vs direct, relayed vs direct WS delivery, connect and upstream-open
// p95, holder setup and upstream failure codes.
//
// The relay is exercised through its real workspace routes
// (/workspaces/<id>/...) with a real Runtime Access Token. Only the token
// issuer (the bench identity) and the target resolver are bench-provided.

import { probeWebSocket, type WsProbeResult } from "./lib/ws"
import type { BenchIdentity } from "./lib/tokens"
import {
  evaluateGates,
  overheadMs,
  percentile,
  round2,
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
  // Lower than connections = paced opens.
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
  // Origin header sent on relayed WS upgrades; it must be one the relay's
  // CORS allowlist admits.
  relayOrigin: string
  // Its public half must be the relay's CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM.
  identity: BenchIdentity
}

/** Run an async task factory over `total` items with a bounded worker pool. */
async function pooled<T>(total: number, limit: number, task: (index: number) => Promise<T>): Promise<T[]> {
  // Filled by index below, so it grows to `total` entries without pre-sizing.
  const results: T[] = []
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

export async function runRow(config: LoadgenConfig): Promise<RowMetrics> {
  const rat = await config.identity.mintRat({ workspaceId: config.workspaceId })

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
