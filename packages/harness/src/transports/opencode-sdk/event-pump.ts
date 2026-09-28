import type { OpenCodeHost } from "./host.js"
import { asNumber as num, asRecord as rec, asString as str } from "@claxedo/helpers/guards"

export type ProjectedEvent = Readonly<{
  id: string
  type: string
  directory?: string
  durable?: Readonly<{ aggregateID: string; seq: number }>
  hintOnly: boolean
  data: unknown
}>

export type EventPumpOptions = Readonly<{
  onEvent(event: ProjectedEvent): void
  onStreamLoss?(): void
  backoffMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
}>

export type EventPump = Readonly<{
  start(): void
  ready(): Promise<void>
  checkpoint(aggregateID: string): number | undefined
  stop(): Promise<void>
}>

const DEFAULT_BACKOFF = [100, 500, 2_000, 5_000] as const

function projectEvent(input: unknown): ProjectedEvent {
  const raw = rec(input) ?? {}
  const cursor = rec(raw.durable)
  const aggregateID = str(cursor?.aggregateID)
  const seq = num(cursor?.seq)
  const durable = aggregateID !== undefined && seq !== undefined ? { aggregateID, seq } : undefined
  const directory = str(rec(raw.location)?.directory)
  return {
    id: str(raw.id) ?? "",
    type: str(raw.type) ?? "",
    ...(directory ? { directory } : {}),
    ...(durable ? { durable } : {}),
    hintOnly: durable === undefined,
    data: raw.data,
  }
}

class OpenCodeEventPump implements EventPump {
  private readonly checkpoints = new Map<string, number>()
  private readonly readiness = Promise.withResolvers<void>()
  private readonly backoff: readonly number[]
  private readonly sleep: (ms: number) => Promise<void>
  private running = false
  private stopped = false
  private attempt = 0
  private abort: AbortController | undefined
  private loop: Promise<void> | undefined

  constructor(private readonly host: OpenCodeHost, private readonly options: EventPumpOptions) {
    this.backoff = options.backoffMs ?? DEFAULT_BACKOFF
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.loop = this.consume()
  }

  ready(): Promise<void> {
    return this.readiness.promise
  }

  checkpoint(aggregateID: string): number | undefined {
    return this.checkpoints.get(aggregateID)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.abort?.abort()
    await this.loop
  }

  private deliver(input: unknown): void {
    const event = projectEvent(input)
    if (event.durable) {
      const seen = this.checkpoints.get(event.durable.aggregateID)
      if (seen !== undefined && event.durable.seq <= seen) return
    }
    try {
      this.options.onEvent(event)
      if (event.durable) this.checkpoints.set(event.durable.aggregateID, event.durable.seq)
    } catch (error) {
      this.host.setEventHealth("degraded")
      console.error("OpenCode event consumer failed", error)
    }
  }

  private async consumeStream(): Promise<void> {
    const client = await this.host.client()
    if (this.stopped) return
    this.abort = new AbortController()
    const iterator = client.events.subscribe({ signal: this.abort.signal })[Symbol.asyncIterator]()
    let next = iterator.next()
    this.readiness.resolve()
    while (true) {
      const item = await next
      if (this.stopped) {
        await iterator.return?.()
        return
      }
      if (item.done) return
      this.attempt = 0
      this.host.setEventHealth("healthy")
      this.deliver(item.value)
      next = iterator.next()
    }
  }

  private async consume(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.consumeStream()
      } catch (error) {
        if (this.stopped) return
        console.error("OpenCode event stream failed", error)
      }
      if (this.stopped) return
      this.host.setEventHealth("degraded")
      this.options.onStreamLoss?.()
      const wait = this.backoff[Math.min(this.attempt, this.backoff.length - 1)] ?? 0
      this.attempt += 1
      await this.sleep(wait)
    }
  }
}

export function createEventPump(host: OpenCodeHost, options: EventPumpOptions): EventPump {
  return new OpenCodeEventPump(host, options)
}
