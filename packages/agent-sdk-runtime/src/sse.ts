import { clearOpaqueTimer } from "./harnesses/shared/opaque-timer"
export type SseFanoutCleanup = () => void
export type SseFanoutMeta = { id?: string }

export type SseReplayBuffer<T> = {
  push(payload: T): { id: string; payload: T }
  idFor(payload: T): string | undefined
  lastId(): string | undefined
  hasGap(lastEventId: string | undefined, throughId?: string): boolean
  replayAfter(lastEventId: string | undefined, throughId?: string): Array<{ id: string; payload: T }>
  isTerminal(payload: T): boolean
}

export function sseHeaders() {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  }
}

export function encodeSseData(payload: unknown, id?: string) {
  return new TextEncoder().encode(`${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(payload)}\n\n`)
}

export function createSseReplayBuffer<T>(input?: {
  maxEvents?: number
  maxTerminalEvents?: number
  isTerminal?: (payload: T) => boolean
  /** Continue a principal-local cursor after its replay ring was evicted. */
  initialSequence?: number
}): SseReplayBuffer<T> {
  const maxEvents = Math.max(1, Math.floor(input?.maxEvents ?? 256))
  const maxTerminalEvents = Math.max(1, Math.floor(input?.maxTerminalEvents ?? 64))
  const events: Array<{ id: string; seq: number; payload: T }> = []
  const terminal: Array<{ id: string; seq: number; payload: T }> = []
  const ids = new WeakMap<object, string>()
  let seq = Math.max(0, Math.floor(input?.initialSequence ?? 0))

  const isTerminal = (payload: T) => input?.isTerminal?.(payload) === true
  const trim = (items: unknown[], max: number) => {
    while (items.length > max) items.shift()
  }
  const numericId = (id: string | undefined) => {
    if (!id) return 0
    const parsed = Number.parseInt(id, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }

  return {
    push(payload) {
      seq += 1
      const event = { id: String(seq), seq, payload }
      events.push(event)
      trim(events, maxEvents)
      if (isTerminal(payload)) {
        terminal.push(event)
        trim(terminal, maxTerminalEvents)
      }
      if (payload && typeof payload === "object") ids.set(payload, event.id)
      return event
    },
    idFor(payload) {
      if (!payload || typeof payload !== "object") return undefined
      return ids.get(payload)
    },
    lastId() {
      return seq > 0 ? String(seq) : undefined
    },
    hasGap(lastEventId, throughId) {
      const after = numericId(lastEventId)
      if (after <= 0) return false
      const through = numericId(throughId) || seq
      if (after >= through) return false
      const seen = new Set<number>()
      const retained = [...events, ...terminal]
        .filter((event) => event.seq > after && event.seq <= through)
        .sort((left, right) => left.seq - right.seq)
        .filter((event) => {
          if (seen.has(event.seq)) return false
          seen.add(event.seq)
          return true
        })
      let expected = after + 1
      for (const event of retained) {
        if (event.seq > expected) return true
        if (event.seq === expected) expected += 1
      }
      return expected <= through
    },
    replayAfter(lastEventId, throughId) {
      const after = numericId(lastEventId)
      const through = numericId(throughId) || seq
      const seen = new Set<string>()
      return [...events, ...terminal]
        .filter((event) => event.seq > after && event.seq <= through)
        .sort((left, right) => left.seq - right.seq)
        .filter((event) => {
          if (seen.has(event.id)) return false
          seen.add(event.id)
          return true
        })
    },
    isTerminal,
  }
}

export function attachSseFanout<T>(input: {
  subscribe: (fn: (event: T) => void) => () => void
  write: (payload: T | { type: "heartbeat" } | { payload: { type: "server.heartbeat"; properties: {} } }, meta?: SseFanoutMeta) => void | Promise<void>
  heartbeat: { type: "heartbeat" } | { payload: { type: "server.heartbeat"; properties: {} } }
  heartbeatMs: number
  lastEventId?: string
  maxPending?: number
  replay?: SseReplayBuffer<T>
  replayLive?: boolean
  isTerminal?: (payload: T) => boolean
  replayGap?: (input: { lastEventId?: string; throughId?: string }) =>
    T | { type: "heartbeat" } | { payload: { type: "server.heartbeat"; properties: {} } }
  onDrop?: (payload: T | { type: "heartbeat" } | { payload: { type: "server.heartbeat"; properties: {} } }) => void
  /** The heartbeat clock. Injectable so a test drives it without patching a global. */
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}): SseFanoutCleanup {
  type Payload = T | { type: "heartbeat" } | { payload: { type: "server.heartbeat"; properties: {} } }
  // Terminality is decided where the value is still known to be a `T`; a
  // heartbeat or a replay-gap frame is never terminal.
  type Pending = { payload: Payload; id?: string; terminal?: boolean }
  const maxPending = Math.max(1, Math.floor(input.maxPending ?? 256))
  const pending: Pending[] = []
  let writing = false
  let closed = false
  const startHeartbeat = input.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const stopHeartbeat = input.clearInterval ?? clearOpaqueTimer
  let heartbeat: unknown
  let unsub = () => {}

  // Read through a function: `closed` flips while `flush` is awaiting a write.
  const isClosed = () => closed

  const cleanup = () => {
    if (closed) return
    closed = true
    pending.length = 0
    if (heartbeat !== undefined) stopHeartbeat(heartbeat)
    unsub()
  }

  const isTerminal = (event: T) => input.replay?.isTerminal(event) === true || input.isTerminal?.(event) === true
  const numericId = (id: string | undefined) => {
    if (!id) return 0
    const parsed = Number.parseInt(id, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }
  const isHeartbeat = (event: Payload) => event === input.heartbeat
  let gapNotice: Pending | undefined
  const dropIndex = () => {
    const heartbeatIndex = pending.findIndex((event) => isHeartbeat(event.payload))
    if (heartbeatIndex !== -1) return heartbeatIndex
    const nonTerminalIndex = pending.findIndex((event) => event.terminal !== true)
    if (nonTerminalIndex !== -1) return nonTerminalIndex
    return pending[0] === gapNotice && pending.length > 1 ? 1 : 0
  }
  // A shed frame is a hole in the reader's view that nothing downstream can
  // detect: the ids it does receive stay monotonic. The hole is reported the
  // same way a rolled replay ring is, so the reader repairs through one path.
  // One notice stands at the head of the queue until it is written; every
  // drop meanwhile is covered by it, and the next drop after it goes out
  // raises a fresh one. The notice is not counted against the cap: shedding
  // it to make room would hide the very loss it reports.
  const noteDrop = (dropped: Pending) => {
    input.onDrop?.(dropped.payload)
    if (isHeartbeat(dropped.payload) || gapNotice || !input.replayGap) return
    gapNotice = {
      payload: input.replayGap({ lastEventId: dropped.id, throughId: input.replay?.lastId() }),
      terminal: true,
    }
    pending.unshift(gapNotice)
  }
  const enqueue = (event: Pending) => {
    if (closed) return
    if (pending.length - (gapNotice ? 1 : 0) >= maxPending) {
      const dropped = pending.splice(dropIndex(), 1)[0]
      if (dropped) noteDrop(dropped)
    }
    pending.push(event)
    void flush()
  }

  const flush = async () => {
    if (writing) return
    writing = true
    try {
      while (!isClosed() && pending.length > 0) {
        const event = pending.shift()!
        if (event === gapNotice) gapNotice = undefined
        await input.write(event.payload, { id: event.id })
      }
    } catch {
      cleanup()
    } finally {
      writing = false
    }
  }

  const deferredLive: Pending[] = []
  let replaying = input.replay !== undefined
  unsub = input.subscribe((event) => {
    const replay = input.replay
    const id = replay
      ? replay.idFor(event) ?? (input.replayLive === false ? undefined : replay.push(event).id)
      : undefined
    const next = { payload: event, id, terminal: isTerminal(event) }
    if (replaying) {
      deferredLive.push(next)
      return
    }
    enqueue(next)
  })
  const throughId = input.replay?.lastId()
  const gap = input.replay?.hasGap(input.lastEventId, throughId) === true
  if (gap && input.replayGap) {
    enqueue({ payload: input.replayGap({ lastEventId: input.lastEventId, throughId }) })
  } else {
    for (const event of input.replay?.replayAfter(input.lastEventId, throughId) ?? []) {
      enqueue({ payload: event.payload, id: event.id, terminal: isTerminal(event.payload) })
    }
  }
  replaying = false
  const through = numericId(throughId)
  for (const event of deferredLive) {
    if (event.id && numericId(event.id) <= through) continue
    enqueue(event)
  }
  heartbeat = startHeartbeat(() => {
    enqueue({ payload: input.heartbeat })
  }, input.heartbeatMs)
  return cleanup
}
