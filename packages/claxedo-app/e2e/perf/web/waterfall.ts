import type { NetworkRecord } from "./recorder"

export type WaterfallRow = {
  readonly id: string
  readonly url: string
  readonly path: string
  readonly kind: "document" | "script" | "stylesheet" | "font" | "image" | "api" | "preflight" | "asset" | "event-stream" | "websocket" | "other"
  readonly method: string
  readonly status: number | undefined
  readonly protocol: string | undefined
  readonly priority: string
  readonly cache: NetworkRecord["cache"]
  readonly encoding: string | undefined
  readonly initiator: string
  readonly waitedOn: string | undefined
  readonly waitedOnUrl: string | undefined
  readonly wave: number
  readonly gapMs: number | undefined
  readonly afterApi: string | undefined
  readonly startMs: number
  readonly endMs: number | undefined
  readonly totalMs: number | undefined
  readonly queuedMs: number | undefined
  readonly stalledMs: number | undefined
  readonly dnsMs: number | undefined
  readonly connectMs: number | undefined
  readonly tlsMs: number | undefined
  readonly ttfbMs: number | undefined
  readonly downloadMs: number | undefined
  readonly transferBytes: number
  readonly decodedBytes: number
  readonly failed: string | undefined
}

export type Waterfall = {
  readonly rows: readonly WaterfallRow[]
  readonly requests: number
  readonly transferBytes: number
  readonly decodedBytes: number
  readonly lastEndMs: number
  readonly byKind: Readonly<Record<string, { readonly count: number; readonly transferBytes: number; readonly ms: number }>>
  readonly waves: number
}

const API_GAP_MS = 50

function kindOf(record: NetworkRecord): WaterfallRow["kind"] {
  if (record.websocket) return "websocket"
  if (record.method === "OPTIONS" || record.initiator.type === "preflight") return "preflight"
  if (record.mimeType === "text/event-stream") return "event-stream"
  if ((record.type === "Fetch" || record.type === "XHR") && record.url.includes("/assets/")) return "asset"
  switch (record.type) {
    case "Document": return "document"
    case "Script": return "script"
    case "Stylesheet": return "stylesheet"
    case "Font": return "font"
    case "Image": return "image"
    case "Fetch":
    case "XHR":
    case "EventSource": return "api"
    default: return "other"
  }
}

export function shortPath(url: string) {
  try {
    const parsed = new URL(url)
    const path = `${parsed.pathname}${parsed.search}`.replace(/ses_[\w-]+/g, "ses_…").replace(/\/(wr|w|workspaces)\/[\w-]{12,}/g, "/$1/…")
    return path.length > 120 ? `${path.slice(0, 117)}…` : path
  } catch {
    return url
  }
}

function round(value: number) {
  return Math.round(value * 10) / 10
}

function initiatorLabel(record: NetworkRecord) {
  const { initiator } = record
  const where = initiator.stackTop ? `${initiator.stackTop.url.split("/").pop()}:${initiator.stackTop.line + 1}${initiator.stackTop.functionName ? ` ${initiator.stackTop.functionName}` : ""}` : initiator.url ? `${initiator.url.split("/").pop()}${initiator.line === undefined ? "" : `:${initiator.line + 1}`}` : ""
  return where ? `${initiator.type} ${where}` : initiator.type
}

function initiatorUrl(record: NetworkRecord) {
  return record.initiator.stackTop?.url || record.initiator.url || undefined
}

export function buildWaterfall(records: readonly NetworkRecord[], originTs: number): Waterfall {
  const ms = (ts: number) => round((ts - originTs) * 1000)
  const rows: WaterfallRow[] = []
  const byUrl = new Map<string, WaterfallRow>()
  const document = records.find((record) => record.type === "Document")
  const api: WaterfallRow[] = []
  for (const record of records) {
    const kind = kindOf(record)
    const timing = record.timing
    const startMs = ms(record.startTs)
    const endMs = record.endTs === undefined ? undefined : ms(record.endTs)
    const requestTimeMs = timing ? ms(timing.requestTime) : undefined
    const phase = (start: number, end: number) => (start >= 0 && end >= start ? round(end - start) : undefined)
    const connectEnd = timing ? Math.max(0, timing.dnsEnd, timing.connectEnd) : 0
    const headersEndMs = timing && requestTimeMs !== undefined ? requestTimeMs + timing.receiveHeadersEnd : undefined
    const initiator = initiatorUrl(record)
    const preflighted = kind === "preflight" ? byUrl.get(record.url) : undefined
    const parent = record === document ? undefined : preflighted ? byUrl.get(preflighted.waitedOnUrl ?? "") : (initiator ? byUrl.get(initiator) : undefined) ?? (document ? byUrl.get(document.url) : undefined)
    const lastApi = kind === "api" ? [...api].reverse().find((row) => row.endMs !== undefined && row.endMs <= startMs && startMs - row.endMs <= API_GAP_MS) : undefined
    const row: WaterfallRow = {
      id: record.id,
      url: record.url,
      path: shortPath(record.url),
      kind,
      method: record.method,
      status: record.status,
      protocol: record.protocol,
      priority: record.priority,
      cache: record.cache,
      encoding: record.encoding,
      initiator: initiatorLabel(record),
      waitedOn: parent?.path,
      waitedOnUrl: parent?.url,
      wave: parent ? parent.wave + 1 : 0,
      gapMs: parent?.endMs === undefined ? undefined : round(startMs - parent.endMs),
      afterApi: lastApi?.path,
      startMs,
      endMs,
      totalMs: endMs === undefined ? undefined : round(endMs - startMs),
      queuedMs: requestTimeMs === undefined ? undefined : round(Math.max(0, requestTimeMs - startMs)),
      stalledMs: timing ? phase(connectEnd, timing.sendStart) : undefined,
      dnsMs: timing ? phase(timing.dnsStart, timing.dnsEnd) : undefined,
      connectMs: timing ? phase(timing.connectStart, timing.connectEnd) : undefined,
      tlsMs: timing ? phase(timing.sslStart, timing.sslEnd) : undefined,
      ttfbMs: timing ? phase(timing.sendEnd, timing.receiveHeadersEnd) : undefined,
      downloadMs: headersEndMs === undefined || endMs === undefined ? undefined : round(Math.max(0, endMs - headersEndMs)),
      transferBytes: record.transferBytes,
      decodedBytes: record.decodedBytes,
      failed: record.failed,
    }
    rows.push(row)
    byUrl.set(record.url, row)
    if (kind === "api") api.push(row)
  }
  const byKind: Record<string, { count: number; transferBytes: number; ms: number }> = {}
  for (const row of rows) {
    const bucket = byKind[row.kind] ?? (byKind[row.kind] = { count: 0, transferBytes: 0, ms: 0 })
    bucket.count += 1
    bucket.transferBytes += row.transferBytes
    bucket.ms = round(bucket.ms + (row.totalMs ?? 0))
  }
  return {
    rows,
    requests: rows.length,
    transferBytes: rows.reduce((sum, row) => sum + row.transferBytes, 0),
    decodedBytes: rows.reduce((sum, row) => sum + row.decodedBytes, 0),
    lastEndMs: Math.max(0, ...rows.map((row) => row.endMs ?? 0)),
    byKind,
    waves: Math.max(0, ...rows.map((row) => row.wave)) + 1,
  }
}
