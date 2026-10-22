/**
 * The machine's doorbell: one long-lived `text/event-stream` from the control
 * plane that says "what the owner declared for this machine changed", so the
 * connector beats at once instead of at its next interval. The stream carries
 * no description; the beat that follows is still the one delivery path.
 */

import { reconnectDelayMs } from "@claxedo/helpers/backoff"

export type MachineEventFrame = { id?: string; data: string }

/**
 * Splits `text/event-stream` bytes into frames as they arrive. A frame ends at
 * a blank line; its `data:` lines are joined with newlines, an `id:` line is
 * carried beside them, and comments and other fields are dropped.
 */
export function createEventStreamParser(onFrame: (frame: MachineEventFrame) => void) {
  const decoder = new TextDecoder()
  let carry = ""
  let data: string[] = []
  let id: string | undefined
  const endFrame = () => {
    if (data.length > 0) onFrame({ ...(id === undefined ? {} : { id }), data: data.join("\n") })
    data = []
    id = undefined
  }
  const line = (text: string) => {
    if (text === "") {
      endFrame()
      return
    }
    if (text.startsWith(":")) return
    const colon = text.indexOf(":")
    const field = colon === -1 ? text : text.slice(0, colon)
    let value = colon === -1 ? "" : text.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "data") data.push(value)
    else if (field === "id") id = value
  }
  return {
    push(chunk: Uint8Array) {
      carry += decoder.decode(chunk, { stream: true })
      const lines = carry.split(/\r\n|\r|\n/)
      carry = lines.pop() ?? ""
      for (const text of lines) line(text)
    },
    end() {
      if (carry) line(carry)
      carry = ""
      endFrame()
    },
  }
}

/** The one event type the stream rings for; every other frame (the heartbeat, a replay-gap notice) is ignored. */
export const HOST_CHANGED_EVENT_TYPE = "host.changed"

export function isHostChangedFrame(frame: MachineEventFrame) {
  try {
    const parsed: unknown = JSON.parse(frame.data)
    return typeof parsed === "object" && parsed !== null && (parsed as { type?: unknown }).type === HOST_CHANGED_EVENT_TYPE
  } catch {
    return false
  }
}

export type MachineEventWatch = { close: () => void }

export type WatchMachineEventsOptions = {
  /**
   * Open one stream. `lastEventId` is the id of the last frame read, sent so
   * the control plane replays a ring that landed while the stream was down.
   * Resolves to the response, or throws for a request that never connected.
   */
  open: (input: { signal: AbortSignal; lastEventId?: string }) => Promise<Response>
  onEvent: () => void
  /**
   * A stream that ended, failed to open, or was refused. The watch reopens
   * after a doubling, jittered wait (`EVENT_STREAM_RECONNECT_MIN_MS` to
   * `EVENT_STREAM_RECONNECT_MAX_MS`) unless `decisive(error)` says the
   * control plane decided against this machine, in which case it stays
   * closed: the next beat is where that decision is acted on.
   */
  onError?: (error: unknown) => void
  decisive: (error: unknown) => boolean
  setTimeout?: (fn: () => void, ms: number) => { cancel: () => void }
  /** The jitter's draw; tests pin it. */
  random?: () => number
}

export class MachineEventStreamRefusedError extends Error {
  constructor(readonly status: number) {
    super(`control plane refused the machine event stream with HTTP ${status}`)
    this.name = "MachineEventStreamRefusedError"
  }
}

export const EVENT_STREAM_RECONNECT_MIN_MS = 1_000
export const EVENT_STREAM_RECONNECT_MAX_MS = 30_000

const defaultSetTimeout = (fn: () => void, ms: number) => {
  const handle = setTimeout(fn, ms)
  return { cancel: () => clearTimeout(handle) }
}

/**
 * Hold the stream open for the life of the watch. A stream that ends is
 * reopened — a control plane deploy, a proxy idle timeout and a laptop's sleep
 * all end it without anyone deciding anything — and a frame read resets the
 * backoff, so a stream that keeps opening and dying backs off while one that
 * works reconnects within a second.
 */
export function watchMachineEvents(options: WatchMachineEventsOptions): MachineEventWatch {
  const later = options.setTimeout ?? defaultSetTimeout
  let closed = false
  let controller: AbortController | undefined
  let timer: { cancel: () => void } | undefined
  let attempt = 0
  let lastEventId: string | undefined

  const schedule = () => {
    if (closed) return
    attempt += 1
    timer = later(() => {
      timer = undefined
      void run()
    }, reconnectDelayMs({ attempt, baseMs: EVENT_STREAM_RECONNECT_MIN_MS, ceilingMs: EVENT_STREAM_RECONNECT_MAX_MS }, options.random))
  }

  const run = async () => {
    if (closed) return
    const abort = new AbortController()
    controller = abort
    try {
      const response = await options.open({ signal: abort.signal, ...(lastEventId === undefined ? {} : { lastEventId }) })
      if (!response.ok) {
        // The body is the control plane's refusal, not a stream; dropping it
        // releases the connection without reading it.
        void response.body?.cancel().catch(() => undefined)
        throw new MachineEventStreamRefusedError(response.status)
      }
      const body = response.body
      if (!body) throw new Error("control plane answered the machine event stream with no body")
      const parser = createEventStreamParser((frame) => {
        attempt = 0
        if (frame.id !== undefined) lastEventId = frame.id
        if (isHostChangedFrame(frame)) options.onEvent()
      })
      const reader = body.getReader()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        parser.push(chunk.value)
      }
      parser.end()
      if (closed) return
      options.onError?.(new Error("the machine event stream ended"))
    } catch (error) {
      if (closed || abort.signal.aborted) return
      options.onError?.(error)
      if (options.decisive(error)) return
    } finally {
      if (controller === abort) controller = undefined
    }
    schedule()
  }

  void run()

  return {
    close() {
      closed = true
      timer?.cancel()
      timer = undefined
      controller?.abort()
      controller = undefined
    },
  }
}
