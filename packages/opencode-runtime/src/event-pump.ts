/**
 * The one retained SDK event pump for this process.
 *
 * Exactly one of these exists per host. Browser subscribers sit downstream of
 * Claxedo's hub, never on this stream — a UI tab disconnecting must not stop
 * the pump or another workspace's turn.
 *
 * Durability is not uniform, and this module's shape follows that fact
 * (docs/architecture/opencode-embedded-sdk-contract.md §5):
 *
 *   - Every event carries `id`.
 *   - SOME events carry `durable: { aggregateID, seq }` — an ordered,
 *     per-aggregate sequence we can checkpoint and use as an idempotency key.
 *     `session.created` and `session.tool.called` do.
 *   - Others do NOT — `session.text.delta`, `session.usage.updated`,
 *     `server.connected`. These are volatile. They can be dropped, duplicated
 *     or reordered by a reconnect, so they are treated as INVALIDATION HINTS
 *     only: they say "something changed, go re-read the snapshot", never
 *     "here is a fact to accumulate".
 *
 * That distinction is the whole reason usage is snapshot-derived. Accumulating
 * `session.usage.updated` deltas would silently over- or under-count across
 * every reconnect.
 *
 * Delivery is at-least-once. Exactly-once effects come from the durable key
 * plus idempotent consumers downstream, never from this module pretending the
 * stream is reliable.
 */
import type { OpenCodeHost } from "./host"

/** A projected OpenCode event, with its durability made explicit. */
export type ProjectedEvent = Readonly<{
  /** SDK event id. Always present. */
  id: string
  type: string
  /** Workspace directory this event belongs to, when the event carries one. */
  directory?: string
  /**
   * Present only for events with an ordered per-aggregate sequence. Consumers
   * that commit durable effects MUST key on this and ignore events without it.
   */
  durable?: Readonly<{ aggregateID: string; seq: number }>
  /**
   * True when this event may only trigger a snapshot re-read. Consumers must
   * not treat the payload as an authoritative fact.
   */
  hintOnly: boolean
  data: unknown
}>

export type EventPumpOptions = Readonly<{
  /**
   * Called for every projected event, at least once. Must be cheap and must
   * not throw; a throwing consumer degrades the pump rather than losing it.
   */
  onEvent(event: ProjectedEvent): void
  /** Reconnect backoff. Bounded; the pump never gives up while running. */
  backoffMs?: readonly number[]
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
}>

export type EventPump = Readonly<{
  /** Begin consuming. Safe to call once; later calls are no-ops. */
  start(): void
  /**
   * Resolves once the subscription has an outstanding read. Mutations that
   * must not race their own first event await this before calling the SDK.
   */
  ready(): Promise<void>
  /** Highest committed seq for an aggregate, or undefined if never seen. */
  checkpoint(aggregateID: string): number | undefined
  /** Stop consuming and release the iterator. Safe to call repeatedly. */
  stop(): Promise<void>
}>

const DEFAULT_BACKOFF = [100, 500, 2_000, 5_000] as const

/**
 * Events whose payload is authoritative because they carry a durable sequence.
 * Everything else is a hint. We decide this from the event shape rather than a
 * hardcoded type list so a new durable event type works without a code change.
 */
function isDurable(event: { durable?: { aggregateID?: string; seq?: number } }): boolean {
  return typeof event.durable?.aggregateID === "string" && typeof event.durable.seq === "number"
}

export function createEventPump(host: OpenCodeHost, options: EventPumpOptions): EventPump {
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const checkpoints = new Map<string, number>()

  let running = false
  let stopped = false
  let abort: AbortController | undefined
  let loop: Promise<void> | undefined
  let markReady: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    markReady = resolve
  })

  function project(raw: Record<string, unknown>): ProjectedEvent {
    const durableRaw = raw.durable as { aggregateID?: string; seq?: number } | undefined
    const durable = isDurable({ durable: durableRaw })
      ? { aggregateID: durableRaw!.aggregateID as string, seq: durableRaw!.seq as number }
      : undefined
    const location = raw.location as { directory?: string } | undefined
    return {
      id: String(raw.id),
      type: String(raw.type),
      ...(location?.directory ? { directory: location.directory } : {}),
      ...(durable ? { durable } : {}),
      hintOnly: durable === undefined,
      data: raw.data,
    }
  }

  async function consume(): Promise<void> {
    let attempt = 0
    while (!stopped) {
      try {
        const client = await host.client()
        abort = new AbortController()
        const iterator = client.events.subscribe({ signal: abort.signal })[Symbol.asyncIterator]()
        let next = iterator.next()
        markReady?.()
        markReady = undefined
        while (true) {
          const item = await next
          if (item.done) break
          const raw = item.value
          next = iterator.next()
          if (stopped) break
          // A healthy delivery resets the backoff ladder.
          attempt = 0
          host.setEventHealth("healthy")
          const event = project(raw as unknown as Record<string, unknown>)
          if (event.durable) {
            const seen = checkpoints.get(event.durable.aggregateID)
            // Monotonic per aggregate: a replayed lower seq is a duplicate.
            if (seen !== undefined && event.durable.seq <= seen) continue
            checkpoints.set(event.durable.aggregateID, event.durable.seq)
          }
          try {
            options.onEvent(event)
          } catch {
            // A bad consumer must not kill the only pump in the process.
            host.setEventHealth("degraded")
          }
        }
        if (stopped) return
        // The stream ended without an error. That is still a loss of liveness.
        host.setEventHealth("degraded")
      } catch {
        if (stopped) return
        // Stream loss. Never synthesize a terminal event here — downstream
        // reconciles from typed snapshots, which is the only safe recovery.
        host.setEventHealth("degraded")
      }
      const wait = backoff[Math.min(attempt, backoff.length - 1)] ?? 0
      attempt += 1
      await sleep(wait)
    }
  }

  return {
    start() {
      if (running) return
      running = true
      loop = consume()
    },
    ready() {
      return ready
    },
    checkpoint(aggregateID) {
      return checkpoints.get(aggregateID)
    },
    async stop() {
      stopped = true
      abort?.abort()
      await loop?.catch(() => {})
    },
  }
}
