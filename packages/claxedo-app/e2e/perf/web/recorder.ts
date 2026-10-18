import type { CDPSession } from "@playwright/test"
import { traceEventsFrom, type TraceEvent } from "../../harness/trace-events"
import type { CpuProfile } from "../panel/trace"

export type Initiator = {
  readonly type: string
  readonly url: string | undefined
  readonly line: number | undefined
  readonly stackTop: { readonly url: string; readonly functionName: string; readonly line: number; readonly column: number } | undefined
}

export type ResponseTiming = {
  readonly requestTime: number
  readonly dnsStart: number
  readonly dnsEnd: number
  readonly connectStart: number
  readonly connectEnd: number
  readonly sslStart: number
  readonly sslEnd: number
  readonly sendStart: number
  readonly sendEnd: number
  readonly receiveHeadersEnd: number
}

export type NetworkRecord = {
  readonly id: string
  readonly url: string
  readonly method: string
  readonly type: string
  readonly priority: string
  readonly initiator: Initiator
  readonly startTs: number
  readonly redirectedFrom: string | undefined
  status: number | undefined
  mimeType: string | undefined
  protocol: string | undefined
  encoding: string | undefined
  cacheControl: string | undefined
  serverTiming: string | undefined
  timing: ResponseTiming | undefined
  cache: "none" | "memory" | "disk" | "prefetch" | "service-worker"
  headersBytes: number
  decodedBytes: number
  transferBytes: number
  endTs: number | undefined
  failed: string | undefined
  websocket: boolean
}

export type Recording = { readonly requests: readonly NetworkRecord[]; readonly traceEvents: readonly TraceEvent[]; readonly profile: CpuProfile | undefined }

export type Recorder = {
  begin(options: { trace: boolean; profile: boolean }): Promise<void>
  end(): Promise<Recording>
}

const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "disabled-by-default-v8.compile",
  "v8",
  "v8.execute",
  "blink.user_timing",
  "loading",
  "latencyInfo",
]

function header(headers: Record<string, string>, name: string) {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name)
  return key === undefined ? undefined : headers[key]
}

export async function startRecorder(cdp: CDPSession): Promise<Recorder> {
  const requests = new Map<string, NetworkRecord>()
  let traceChunks: TraceEvent[] = []
  let tracing = false
  let profiling = false
  cdp.on("Network.requestWillBeSent", (event) => {
    const frame = event.initiator.stack?.callFrames.find((candidate) => candidate.url)
    const previous = event.redirectResponse ? requests.get(event.requestId) : undefined
    if (previous) {
      previous.status = event.redirectResponse?.status
      previous.endTs = event.timestamp
      requests.set(`${event.requestId}:redirect:${event.timestamp}`, previous)
    }
    requests.set(event.requestId, {
      id: event.requestId,
      url: event.request.url,
      method: event.request.method,
      type: event.type ?? "Other",
      priority: event.request.initialPriority,
      initiator: {
        type: event.initiator.type,
        url: event.initiator.url,
        line: event.initiator.lineNumber,
        stackTop: frame ? { url: frame.url, functionName: frame.functionName, line: frame.lineNumber, column: frame.columnNumber } : undefined,
      },
      startTs: event.timestamp,
      redirectedFrom: previous?.url,
      status: undefined, mimeType: undefined, protocol: undefined, encoding: undefined, cacheControl: undefined, serverTiming: undefined, timing: undefined,
      cache: "none", headersBytes: 0, decodedBytes: 0, transferBytes: 0, endTs: undefined, failed: undefined, websocket: false,
    })
  })
  cdp.on("Network.requestServedFromCache", (event) => {
    const record = requests.get(event.requestId)
    if (record) record.cache = "memory"
  })
  cdp.on("Network.responseReceived", (event) => {
    const record = requests.get(event.requestId)
    if (!record) return
    const response = event.response
    record.status = response.status
    record.mimeType = response.mimeType
    record.protocol = response.protocol
    record.encoding = header(response.headers, "content-encoding")
    record.cacheControl = header(response.headers, "cache-control")
    record.serverTiming = header(response.headers, "server-timing")
    record.headersBytes = response.encodedDataLength
    if (response.timing) record.timing = response.timing
    if (response.fromServiceWorker) record.cache = "service-worker"
    else if (response.fromPrefetchCache) record.cache = "prefetch"
    else if (response.fromDiskCache) record.cache = "disk"
  })
  cdp.on("Network.dataReceived", (event) => {
    const record = requests.get(event.requestId)
    if (record) record.decodedBytes += event.dataLength
  })
  cdp.on("Network.loadingFinished", (event) => {
    const record = requests.get(event.requestId)
    if (!record) return
    record.endTs = event.timestamp
    record.transferBytes = event.encodedDataLength
  })
  cdp.on("Network.loadingFailed", (event) => {
    const record = requests.get(event.requestId)
    if (!record) return
    record.endTs = event.timestamp
    record.failed = event.errorText || (event.canceled ? "canceled" : "failed")
  })
  cdp.on("Network.webSocketCreated", (event) => {
    requests.set(event.requestId, {
      id: event.requestId, url: event.url, method: "GET", type: "WebSocket", priority: "", startTs: Number.NaN, redirectedFrom: undefined,
      initiator: { type: event.initiator?.type ?? "other", url: event.initiator?.url, line: undefined, stackTop: undefined },
      status: undefined, mimeType: undefined, protocol: "websocket", encoding: undefined, cacheControl: undefined, serverTiming: undefined, timing: undefined,
      cache: "none", headersBytes: 0, decodedBytes: 0, transferBytes: 0, endTs: undefined, failed: undefined, websocket: true,
    })
  })
  cdp.on("Network.webSocketWillSendHandshakeRequest", (event) => {
    const record = requests.get(event.requestId)
    if (record) Object.assign(record, { startTs: event.timestamp })
  })
  cdp.on("Network.webSocketHandshakeResponseReceived", (event) => {
    const record = requests.get(event.requestId)
    if (!record) return
    record.status = event.response.status
    record.endTs = event.timestamp
  })
  cdp.on("Tracing.dataCollected", (event) => {
    if (tracing) traceChunks.push(...traceEventsFrom(event))
  })
  await cdp.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 })
  await cdp.send("Profiler.enable")
  await cdp.send("Profiler.setSamplingInterval", { interval: 250 })
  return {
    begin: async ({ trace, profile }) => {
      for (const [id, record] of requests) if (record.endTs !== undefined || record.failed) requests.delete(id)
      traceChunks = []
      if (profile) {
        profiling = true
        await cdp.send("Profiler.start")
      }
      if (trace) {
        tracing = true
        await cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: TRACE_CATEGORIES, recordMode: "recordContinuously" } })
      }
    },
    end: async () => {
      let profile: CpuProfile | undefined
      if (profiling) {
        profiling = false
        profile = ((await cdp.send("Profiler.stop")) as { profile: CpuProfile }).profile
      }
      if (tracing) {
        const complete = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()))
        await cdp.send("Tracing.end")
        await complete
        tracing = false
      }
      return { requests: [...new Set(requests.values())].filter((record) => Number.isFinite(record.startTs)).sort((a, b) => a.startTs - b.startTs), traceEvents: traceChunks, profile }
    },
  }
}
