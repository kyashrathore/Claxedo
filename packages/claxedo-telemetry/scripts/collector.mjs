/**
 * A local OTLP/HTTP collector that prints traces as trees.
 *
 * The point is not to replace a real collector — it is that a real one is a
 * container, a config file, and a UI to learn, and the question being asked
 * here is usually small and urgent: "the app says the host is offline; how far
 * did the request actually get?" This answers that in a terminal, from the
 * spans the chain already emits, with no infrastructure.
 *
 * Point any service at it:
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
 *
 * It speaks the same OTLP/HTTP JSON the engine's exporter
 * (`packages/core/src/observability/otlp.ts`) speaks, so the agent engine can
 * report to it too and its spans join the same trees.
 *
 *   node scripts/collector.mjs [--port 4318] [--quiet]
 */

import { createServer } from "node:http"

const args = process.argv.slice(2)
const port = Number(args[args.indexOf("--port") + 1]) || 4318
const quiet = args.includes("--quiet")

/** traceId -> spans. Kept whole so a tree can be drawn once a trace goes quiet. */
const traces = new Map()
/** traceId -> timer that prints the trace once no new span has arrived. */
const pending = new Map()
/**
 * How long to wait before printing. A trace arrives in pieces from several
 * services, each flushing on its own schedule, so printing on first sight would
 * show one span per hop as it lands and never the shape.
 */
const SETTLE_MS = 1_500

function attributeValue(value) {
  if (!value) return undefined
  if (value.stringValue !== undefined) return value.stringValue
  if (value.intValue !== undefined) return Number(value.intValue)
  if (value.doubleValue !== undefined) return value.doubleValue
  if (value.boolValue !== undefined) return value.boolValue
  return undefined
}

function attributes(list) {
  return Object.fromEntries((list ?? []).map((entry) => [entry.key, attributeValue(entry.value)]))
}

function ingest(payload) {
  for (const resourceSpans of payload.resourceSpans ?? []) {
    const resource = attributes(resourceSpans.resource?.attributes)
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        const record = {
          service: resource["service.name"] ?? "unknown",
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          name: span.name,
          kind: span.kind,
          start: BigInt(span.startTimeUnixNano),
          end: BigInt(span.endTimeUnixNano),
          status: span.status?.code ?? 0,
          statusMessage: span.status?.message,
          attributes: attributes(span.attributes),
          events: (span.events ?? []).map((event) => ({
            name: event.name,
            attributes: attributes(event.attributes),
          })),
        }
        const existing = traces.get(record.traceId) ?? []
        existing.push(record)
        traces.set(record.traceId, existing)

        clearTimeout(pending.get(record.traceId))
        pending.set(record.traceId, setTimeout(() => print(record.traceId), SETTLE_MS).unref?.() ?? setTimeout(() => {}, 0))
      }
    }
  }
}

const KIND = { 1: "internal", 2: "server", 3: "client", 4: "producer", 5: "consumer" }

function print(traceId) {
  pending.delete(traceId)
  const spans = traces.get(traceId)
  if (!spans || quiet) return

  const byParent = new Map()
  const ids = new Set(spans.map((span) => span.spanId))
  for (const span of spans) {
    // A span whose parent is not in this batch is a ROOT here: the parent may
    // live in a service that is not reporting, and hiding such a span would
    // hide exactly the hop that is missing.
    const key = span.parentSpanId && ids.has(span.parentSpanId) ? span.parentSpanId : "__root__"
    byParent.set(key, [...(byParent.get(key) ?? []), span])
  }

  const origin = spans.reduce((least, span) => (span.start < least ? span.start : least), spans[0].start)
  const totalMs = Number(spans.reduce((most, span) => (span.end > most ? span.end : most), spans[0].end) - origin) / 1e6

  console.log(`\n━━ trace ${traceId}  ·  ${spans.length} spans  ·  ${totalMs.toFixed(1)}ms`)

  const walk = (parentId, depth) => {
    const children = (byParent.get(parentId) ?? []).sort((a, b) => (a.start < b.start ? -1 : 1))
    for (const span of children) {
      const durationMs = Number(span.end - span.start) / 1e6
      const offsetMs = Number(span.start - origin) / 1e6
      const mark = span.status === 2 ? "✗" : " "
      console.log(
        `${mark} ${"  ".repeat(depth)}${span.service} · ${span.name}` +
          `  [${KIND[span.kind] ?? span.kind}] +${offsetMs.toFixed(1)}ms ${durationMs.toFixed(1)}ms`,
      )
      if (span.statusMessage) console.log(`   ${"  ".repeat(depth)}  ↳ ${span.statusMessage}`)
      for (const [key, value] of Object.entries(span.attributes)) {
        if (value === undefined) continue
        console.log(`   ${"  ".repeat(depth)}  ${key}=${value}`)
      }
      for (const event of span.events) {
        const detail = Object.entries(event.attributes)
          .map(([key, value]) => `${key}=${value}`)
          .join(" ")
        console.log(`   ${"  ".repeat(depth)}  • ${event.name}${detail ? ` ${detail}` : ""}`)
      }
      walk(span.spanId, depth + 1)
    }
  }
  walk("__root__", 0)

  // A trace with exactly one service is a propagation failure, not a short
  // request: every hop in this chain is supposed to continue the trace it was
  // given, so a lone service means the next hop started its own.
  const services = new Set(spans.map((span) => span.service))
  if (services.size === 1) {
    console.log(`   only one service reported (${[...services][0]}) — the next hop did not continue this trace`)
  }
  traces.delete(traceId)
}

createServer((request, response) => {
  if (request.method !== "POST" || !request.url?.startsWith("/v1/traces")) {
    response.writeHead(404).end()
    return
  }
  const chunks = []
  request.on("data", (chunk) => chunks.push(chunk))
  request.on("end", () => {
    try {
      ingest(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    } catch (error) {
      console.error("collector: bad payload", String(error))
    }
    // OTLP wants an empty partial-success body on 200.
    response.writeHead(200, { "content-type": "application/json" }).end("{}")
  })
}).listen(port, "127.0.0.1", () => {
  console.log(`OTLP collector on http://127.0.0.1:${port}  (point OTEL_EXPORTER_OTLP_ENDPOINT here)`)
})
