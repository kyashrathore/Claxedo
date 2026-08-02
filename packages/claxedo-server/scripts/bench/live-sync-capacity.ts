/**
 * `live-sync-capacity` — how many concurrent connections one `LiveSyncRoom`
 * Durable Object actually holds, and how long a nudge takes to reach all of
 * them.
 *
 * WHY THIS EXISTS: `MAX_CONNECTIONS` was 256, asserted rather than measured,
 * against a Cloudflare per-DO hibernatable-socket limit of roughly 32,000. The
 * cheap conclusion from that gap is "shard the room", which is a large change
 * with real hazards (cursors do not survive a shard move; shrinking the shard
 * count is a silent blackout for subscribers held on retired shards). Before
 * paying for it, measure: if one room holds the target load, sharding removes
 * no ceiling. This harness is the decision input, and the number it produces is
 * what `DEFAULT_MAX_CONNECTIONS` is derived from.
 *
 * WHAT IS REAL HERE: workerd via miniflare, the same runtime the Worker deploys
 * to, with the real Durable Object namespace — so `state.acceptWebSocket`,
 * hibernation, and the internal-WebSocket-to-SSE bridge are the production code
 * paths, not doubles. Each measured connection goes through
 * `connectLiveSyncRoom` exactly as a browser's would.
 *
 * WHAT IS NOT: the client end is in-process rather than across a network, so
 * these numbers isolate ROOM cost (per-connection attachment read, visibility
 * filter, socket write) and say nothing about edge or TLS cost. That is the
 * right scope — the cap governs room work — but it means the harness, not the
 * room, is usually what saturates first, and the report says which it was.
 *
 * Usage:
 *   node --import tsx scripts/bench/live-sync-capacity.ts
 *   node --import tsx scripts/bench/live-sync-capacity.ts 256 1000 4000
 */

import { build } from "esbuild"
import { Miniflare } from "miniflare"

const DEFAULT_STEPS = [256, 1_000, 2_000, 4_000]

/**
 * The room is driven past its own default cap on purpose: the harness exists to
 * find where the ROOM breaks, and a 503 from the cap under test would mean
 * measuring the cap instead of the thing the cap is supposed to protect.
 *
 * NOTE: the room CLAMPS this to `MAX_CONNECTIONS_CEILING` (16,000), so steps
 * above that will report `capRefused` rather than a capacity result. To probe
 * higher, raise the ceiling in `live-sync-room.cf.ts` for the duration of the run —
 * and read the `capRefused` column, which exists so a clamp can never be
 * mistaken for a measured limit.
 */
const HARNESS_CAP = 1_000_000

/**
 * Thrown when the ROOM's own cap refused a connection, as opposed to the
 * runtime or the harness running out of capacity. Kept distinct so a run that
 * stalls at the configured limit cannot be misread as a measured ceiling.
 */
class CapRejection extends Error {}

/** Per-connection budget for the bootstrap frame to arrive. */
const OPEN_TIMEOUT_MS = 30_000
/** Budget for a nudge to reach every held connection once published. */
const FANOUT_TIMEOUT_MS = 60_000

async function bundleWorker() {
  const roomModule = new URL("../../src/deployments/hosted-workerd/live-sync-room.cf.ts", import.meta.url).pathname
  const bundled = await build({
    stdin: {
      contents: `
        import { LiveSyncRoom, connectLiveSyncRoom, nudgeLiveSyncRoom } from ${JSON.stringify(roomModule)}
        export { LiveSyncRoom }

        // One subject per connection. workgraph.changed is subject-scoped, so a
        // nudge for owner "*" would reach nobody; the bench instead publishes
        // document.changed, which is ORG-scoped and therefore visible to every
        // connection in the room. That is deliberately the widest fan-out the
        // room supports — the case the cap has to be safe for.
        const subscriber = (subject, orgId) => ({
          auth: {
            mode: "signed",
            token: "bench",
            user: { subject, tokenIdentifier: subject, issuer: "bench" },
          },
          orgId,
        })

        export default {
          fetch(request, env) {
            const url = new URL(request.url)
            const org = url.searchParams.get("org") ?? "bench"
            if (url.pathname === "/connect") {
              return connectLiveSyncRoom(
                env.LIVE_SYNC_ROOM,
                subscriber(url.searchParams.get("as") ?? "alice", org),
                // A heartbeat far beyond any run, so periodic frames never
                // interleave with the frames being timed.
                3600000,
              )
            }
            if (url.pathname === "/nudge") {
              return nudgeLiveSyncRoom(env.LIVE_SYNC_ROOM, "org:" + org, {
                type: "document.changed",
                documentId: url.searchParams.get("doc") ?? "doc_1",
                orgId: org,
                projectId: "proj_1",
                ts: Date.now(),
              }).then((result) => Response.json(result))
            }
            return new Response("not found", { status: 404 })
          },
        }
      `,
      loader: "ts",
      resolveDir: new URL("../../src/", import.meta.url).pathname,
      sourcefile: "live-sync-capacity-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  })
  return bundled.outputFiles[0]!.text
}

type Held = {
  reader: { read(): Promise<{ value?: Uint8Array; done: boolean }>; cancel(): Promise<unknown> }
  /** Resolved by the reader loop when this connection sees the awaited document id. */
  awaitFrame(documentId: string): Promise<void>
  stop(): Promise<void>
}

/**
 * Open one bridged connection and pump its SSE body in the background.
 *
 * The read loop must run continuously rather than on demand: the bridge closes
 * a stream whose queue fills (`live-sync client is too slow`, a 32-frame
 * highWaterMark), so a harness that only read when it wanted to measure would
 * be measuring its own backpressure. Frames are matched by `documentId`, so a
 * fan-out timing is unambiguous even if an earlier round's frame is still in
 * flight.
 */
async function open(miniflare: Miniflare, org: string, subject: string): Promise<Held> {
  const response = await miniflare.dispatchFetch(`http://bench/connect?org=${org}&as=${subject}`)
  if (response.status === 503) {
    // The room's OWN cap refused this connection. Reported distinctly because
    // conflating it with a capacity failure is how a harness ends up
    // "measuring" the constant it was built to replace: a run that stops at a
    // round number is far more likely to have hit a policy limit than a
    // runtime one, and the two demand opposite conclusions.
    throw new CapRejection(`room cap refused ${subject}`)
  }
  if (!response.ok || !response.body) {
    throw new Error(`connect failed: ${response.status} ${await response.text()}`)
  }
  const reader = response.body.getReader() as Held["reader"]
  const decoder = new TextDecoder()
  const waiters = new Map<string, () => void>()
  let seen = new Set<string>()
  let bootstrapped: () => void = () => {}
  const bootstrap = new Promise<void>((resolve) => {
    bootstrapped = resolve
  })
  let stopped = false

  const pump = (async () => {
    let text = ""
    while (!stopped) {
      const next = await reader.read().catch(() => ({ done: true } as const))
      if (next.done) return
      text += decoder.decode(next.value, { stream: true })
      const blocks = text.split("\n\n")
      text = blocks.pop() ?? ""
      for (const block of blocks) {
        const data = block
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice("data:".length)
          .trim()
        if (!data) continue
        let parsed: { type?: string; documentId?: string }
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }
        if (parsed.type === "heartbeat") {
          bootstrapped()
          continue
        }
        if (parsed.type !== "document.changed" || !parsed.documentId) continue
        seen.add(parsed.documentId)
        waiters.get(parsed.documentId)?.()
      }
    }
  })()

  await withTimeout(bootstrap, OPEN_TIMEOUT_MS, `connection ${subject} never received its bootstrap frame`)

  return {
    reader,
    awaitFrame(documentId: string) {
      if (seen.has(documentId)) return Promise.resolve()
      return new Promise<void>((resolve) => waiters.set(documentId, resolve))
    },
    async stop() {
      stopped = true
      await reader.cancel().catch(() => {})
      await pump.catch(() => {})
      waiters.clear()
      seen = new Set()
    },
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

type StepResult = {
  target: number
  connected: number
  connectFailures: number
  /** Connections refused by the room's configured cap, not by capacity. */
  capRejections: number
  /** What the ROOM reported holding, from the nudge response — its own count. */
  held: number
  delivered: number
  /** Wall time from issuing the nudge until every connection had the frame. */
  fanoutMs: number
  /** Per-connection arrival spread, the closest stand-in for a fan-out p99. */
  p50Ms: number
  p99Ms: number
  note?: string
}

async function measureStep(miniflare: Miniflare, target: number, held: Held[], org: string): Promise<StepResult> {
  let connectFailures = 0
  let capRejections = 0
  const failures: string[] = []
  const first = held.length
  // Connections are opened in modest batches: opening 4,000 at once makes the
  // harness's own scheduling the bottleneck and produces a connect-failure
  // number that describes Node, not the room.
  const BATCH = 64
  for (let index = first; index < target; index += BATCH) {
    const batch = Array.from({ length: Math.min(BATCH, target - index) }, (_, offset) =>
      open(miniflare, org, `u${index + offset}`).then(
        (connection) => held.push(connection),
        (error: unknown) => {
          if (error instanceof CapRejection) capRejections += 1
          else {
            connectFailures += 1
            if (failures.length < 3) failures.push(error instanceof Error ? error.message : String(error))
          }
        },
      ),
    )
    await Promise.all(batch)
  }

  const documentId = `doc_${target}_${Date.now()}`
  const arrivals: number[] = []
  const waits = held.map((connection) =>
    connection.awaitFrame(documentId).then(() => {
      arrivals.push(performance.now())
    }),
  )
  const started = performance.now()
  const nudge = (await miniflare
    .dispatchFetch(`http://bench/nudge?org=${org}&doc=${documentId}`)
    .then((response) => response.json())) as { delivered: number; held: number }
  await withTimeout(
    Promise.all(waits),
    FANOUT_TIMEOUT_MS,
    `fan-out at ${target}: only ${arrivals.length}/${held.length} connections received the frame`,
  )
  const fanoutMs = performance.now() - started
  const offsets = arrivals.map((at) => at - started).sort((left, right) => left - right)

  return {
    target,
    connected: held.length,
    connectFailures,
    capRejections,
    held: nudge.held,
    delivered: nudge.delivered,
    fanoutMs,
    p50Ms: percentile(offsets, 0.5),
    p99Ms: percentile(offsets, 0.99),
    ...(failures.length > 0 ? { note: `connect errors: ${failures.join("; ")}` } : {}),
  }
}

function percentile(sorted: number[], fraction: number) {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]!
}

async function main() {
  const steps = (process.argv.slice(2).map(Number).filter((value) => Number.isFinite(value) && value > 0))
  const targets = (steps.length > 0 ? steps : DEFAULT_STEPS).sort((left, right) => left - right)

  const contents = await bundleWorker()
  const miniflare = new Miniflare({
    compatibilityDate: "2026-07-18",
    modules: [{ type: "ESModule", path: "index.mjs", contents }],
    durableObjects: { LIVE_SYNC_ROOM: "LiveSyncRoom" },
    bindings: { LIVE_SYNC_MAX_CONNECTIONS: String(HARNESS_CAP) },
  })

  const org = `bench${Date.now()}`
  const held: Held[] = []
  const results: StepResult[] = []
  try {
    for (const target of targets) {
      // Connections accumulate across steps, so each step measures fan-out to
      // the FULL population rather than to a freshly-opened batch — one room
      // holding all of them, which is the question.
      try {
        const result = await measureStep(miniflare, target, held, org)
        results.push(result)
        report(result)
      } catch (error) {
        results.push({
          target,
          connected: held.length,
          connectFailures: target - held.length,
          capRejections: 0,
          held: Number.NaN,
          delivered: Number.NaN,
          fanoutMs: Number.NaN,
          p50Ms: Number.NaN,
          p99Ms: Number.NaN,
          note: error instanceof Error ? error.message : String(error),
        })
        report(results.at(-1)!)
        break
      }
    }
  } finally {
    // Sequential teardown: cancelling thousands of readers at once reliably
    // wedges miniflare's dispose.
    for (const connection of held) await connection.stop()
    await miniflare.dispose()
  }

  console.log("\n| target | connected | connect success | cap-refused | room held | delivered | fan-out total | p50 | p99 |")
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
  for (const result of results) {
    const rate = result.target === 0 ? 0 : (result.connected / result.target) * 100
    console.log(
      `| ${result.target} | ${result.connected} | ${rate.toFixed(1)}% | ${result.capRejections} | ${result.held} | ${result.delivered}`
        + ` | ${ms(result.fanoutMs)} | ${ms(result.p50Ms)} | ${ms(result.p99Ms)} |`,
    )
    if (result.note) console.log(`  note: ${result.note}`)
  }
}

function ms(value: number) {
  return Number.isFinite(value) ? `${value.toFixed(0)}ms` : "n/a"
}

function report(result: StepResult) {
  console.log(
    `[${result.target}] connected=${result.connected} failures=${result.connectFailures}`
      + ` capRefused=${result.capRejections} roomHeld=${result.held} delivered=${result.delivered}`
      + ` fanout=${ms(result.fanoutMs)} p50=${ms(result.p50Ms)} p99=${ms(result.p99Ms)}`
      + (result.note ? ` note=${result.note}` : ""),
  )
}

await main()
