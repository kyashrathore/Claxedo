import type { OpenCodeHost } from "./host"
import { num, rec, str } from "./value"

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

function durableCursor(input: unknown): { aggregateID: string; seq: number } | undefined {
  const durable = rec(input)
  const aggregateID = str(durable?.aggregateID)
  const seq = num(durable?.seq)
  return aggregateID !== undefined && seq !== undefined ? { aggregateID, seq } : undefined
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

  function project(input: unknown): ProjectedEvent {
    const raw = rec(input) ?? {}
    const durable = durableCursor(raw.durable)
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

  function pumpActive(): boolean {
    return !stopped
  }

  async function consume(): Promise<void> {
    let attempt = 0
    while (pumpActive()) {
      try {
        const client = await host.client()
        if (stopped) return
        abort = new AbortController()
        const iterator = client.events.subscribe({ signal: abort.signal })[Symbol.asyncIterator]()
        let next = iterator.next()
        markReady?.()
        markReady = undefined
        while (true) {
          const item = await next
          if (stopped) {

            await iterator.return?.()
            return
          }
          if (item.done) break
          const raw = item.value
          
          attempt = 0
          host.setEventHealth("healthy")
          const event = project(raw)
          if (event.durable) {
            const seen = checkpoints.get(event.durable.aggregateID)
            
            if (seen !== undefined && event.durable.seq <= seen) {
              next = iterator.next()
              continue
            }
            checkpoints.set(event.durable.aggregateID, event.durable.seq)
          }
          try {
            options.onEvent(event)
          } catch {
            
            host.setEventHealth("degraded")
          }
          next = iterator.next()
        }
        
        host.setEventHealth("degraded")
      } catch {
        if (stopped) return

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
