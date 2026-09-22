/**
 * Getting finished spans out of the process.
 *
 * Every runtime in this chain ends a request differently, and each way loses
 * spans if the exporter assumes another:
 *
 *   - A Cloudflare Worker is FROZEN the moment its response is returned. A
 *     pending `fetch` to the collector is simply killed unless it is handed to
 *     `waitUntil`, so the Worker path takes an explicit `defer`.
 *   - A browser tab can be closed mid-flight, so the page flushes on
 *     `visibilitychange` with `sendBeacon`, which survives unload.
 *   - Node just needs the batch to be flushed before exit.
 *
 * Failure to export is never allowed to affect the traced program: a collector
 * that is down, slow, or absent must look exactly like telemetry being off.
 */

import { encodeOtlpSpans, type FinishedSpan, type Resource } from "./span"

export type ExporterOptions = {
  /** OTLP/HTTP base endpoint, e.g. `http://127.0.0.1:4318`. `/v1/traces` is appended. */
  endpoint: string
  resource: Resource
  headers?: Record<string, string>
  /** Send once this many spans are queued. */
  maxBatchSize?: number
  /**
   * Telemetry consent — checked before a span is queued and again before a
   * batch is sent, so spans queued before consent was withdrawn never leave
   * the process. Omitted, nothing is ever sent: an exporter without a consent
   * answer is constructed but never enabled.
   */
  consent?: () => boolean
  /**
   * Hand an in-flight send to the runtime so it is not cancelled.
   *
   * In a Worker this is `ctx.waitUntil`. Everywhere else the default is fine.
   */
  defer?: (work: Promise<unknown>) => void
  fetch?: typeof fetch
}

export type SpanExporter = {
  /** Queue a finished span. Never throws, never awaits. */
  accept: (span: FinishedSpan) => void
  /** Send whatever is queued. Resolves when the attempt is over, success or not. */
  flush: () => Promise<void>
}

export function createOtlpExporter(options: ExporterOptions): SpanExporter {
  const endpoint = `${options.endpoint.replace(/\/+$/, "")}/v1/traces`
  const maxBatchSize = options.maxBatchSize ?? 128
  const send = options.fetch ?? fetch
  const defer = options.defer ?? ((work: Promise<unknown>) => void work.catch(() => {}))
  const consent = options.consent ?? (() => false)
  // A throwing consent check must not take the traced program down — fail closed.
  const consented = () => {
    try {
      return consent()
    } catch {
      return false
    }
  }
  let queued: FinishedSpan[] = []

  const post = async (batch: readonly FinishedSpan[]) => {
    if (batch.length === 0 || !consented()) return
    try {
      await send(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headers },
        body: JSON.stringify(encodeOtlpSpans(options.resource, batch)),
        // A collector that hangs must not hold a Worker open to its limit.
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      // Deliberately silent. A warning here would fire on every span for as
      // long as the collector is down, and drown the logs this is meant to
      // make readable.
    }
  }

  return {
    accept(span) {
      if (!consented()) return
      queued.push(span)
      if (queued.length < maxBatchSize) return
      const batch = queued
      queued = []
      defer(post(batch))
    },
    async flush() {
      if (queued.length === 0) return
      const batch = queued
      queued = []
      await post(batch)
    },
  }
}

/**
 * Read the standard OTel environment (`OTEL_EXPORTER_OTLP_*`), so one
 * collector configuration serves the agent harnesses and this chain and their
 * spans join.
 *
 * Returns undefined when no endpoint is set, which is what turns tracing off.
 */
export function otlpConfigFromEnv(env: Record<string, string | undefined>) {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  if (!endpoint) return undefined
  const raw = env.OTEL_EXPORTER_OTLP_HEADERS?.trim()
  const headers = raw
    ? Object.fromEntries(
        raw
          .split(",")
          .map((entry) => entry.split("="))
          .filter((parts): parts is [string, ...string[]] => parts.length >= 2)
          .map(([key, ...value]) => [key.trim(), value.join("=").trim()]),
      )
    : undefined
  return { endpoint, ...(headers && Object.keys(headers).length ? { headers } : {}) }
}
