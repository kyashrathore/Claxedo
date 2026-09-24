import type { ServerEvent } from "../events"

export type Coalescer = {
  readonly push: (event: ServerEvent) => void
  readonly flush: () => void
}

type Delta = Extract<ServerEvent, { type: "partDelta" }>

function partKey(event: { ref: { sessionId: string }; messageId: string; partId: string }) {
  return `${event.ref.sessionId}:${event.messageId}:${event.partId}`
}

function deltaKey(event: Delta) {
  return `${partKey(event)}:${event.field}`
}

function partCarriesText(part: unknown) {
  return !!part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
}

export function coalesceEvents(events: readonly ServerEvent[]): ServerEvent[] {
  const out: (ServerEvent | undefined)[] = []
  const deltaAt = new Map<string, number>()
  const deltasOfPart = new Map<string, number[]>()
  for (const event of events) {
    if (event.type === "partDelta") {
      const key = deltaKey(event)
      const index = deltaAt.get(key)
      if (index !== undefined) {
        const current = out[index] as Delta
        out[index] = { ...current, delta: current.delta + event.delta }
        continue
      }
      deltaAt.set(key, out.length)
      const part = partKey(event)
      deltasOfPart.set(part, [...(deltasOfPart.get(part) ?? []), out.length])
      out.push(event)
      continue
    }
    if (event.type === "partUpserted" && partCarriesText(event.part)) {
      const part = `${event.ref.sessionId}:${event.part.messageID}:${event.part.id}`
      for (const index of deltasOfPart.get(part) ?? []) out[index] = undefined
      deltasOfPart.delete(part)
    }
    out.push(event)
  }
  return out.filter((event): event is ServerEvent => event !== undefined)
}

function nextFrame(run: () => void) {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => run())
    return
  }
  setTimeout(run, 16)
}

export function createCoalescer(emit: (events: readonly ServerEvent[]) => void, schedule: (run: () => void) => void = nextFrame): Coalescer {
  let queue: ServerEvent[] = []
  let scheduled = false
  const flush = () => {
    scheduled = false
    if (queue.length === 0) return
    const batch = queue
    queue = []
    emit(coalesceEvents(batch))
  }
  return {
    push: (event) => {
      queue.push(event)
      if (scheduled) return
      scheduled = true
      schedule(flush)
    },
    flush,
  }
}
