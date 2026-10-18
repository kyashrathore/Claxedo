import { intervals, summarize, type Summary } from "./pipes"

export type TimedFrame = { at: number; type: string | undefined; sessionId: string | undefined; messageId: string | undefined; data: Record<string, unknown> }

const asError = (failure: unknown) => failure instanceof Error ? failure : new Error(typeof failure === "string" ? failure : "The event stream failed")

export type TimedStream = {
  frames: TimedFrame[]
  opened: Promise<void>
  /** Resolves with the first frame after `after` (in time) that `match` admits. */
  waitFor(match: (frame: TimedFrame) => boolean, after: number, timeoutMs: number, label: string): Promise<TimedFrame>
  close(): void
}

function frameOf(block: string, at: number): TimedFrame | undefined {
  const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
  if (!data.startsWith("{")) return undefined
  const parsed = JSON.parse(data) as Record<string, unknown>
  const payload = parsed.payload as { type?: unknown; properties?: Record<string, unknown> } | undefined
  const type = typeof payload?.type === "string" ? payload.type : typeof parsed.type === "string" ? parsed.type : undefined
  const properties = payload?.properties
  const sessionId = properties?.sessionID ?? (properties?.info as { sessionID?: unknown } | undefined)?.sessionID
  const messageId = properties?.messageID ?? (properties?.info as { id?: unknown } | undefined)?.id
  return { at, type, sessionId: typeof sessionId === "string" ? sessionId : undefined, messageId: typeof messageId === "string" ? messageId : undefined, data: parsed }
}

/** Reads a `text/event-stream` body, stamping each frame with the time its bytes arrived. */
export function timedStream(response: Promise<Response>): TimedStream {
  const frames: TimedFrame[] = []
  const waiters = new Set<(frame: TimedFrame) => void>()
  let failed: unknown
  const failures = new Set<(error: unknown) => void>()
  const controller = new AbortController()
  const { promise: opened, resolve: open, reject: refuse } = Promise.withResolvers<void>()
  void (async () => {
    const answer = await response
    if (!answer.ok || !answer.body) throw new Error(`The event stream was refused: ${answer.status} ${await answer.text()}`)
    open()
    const reader = answer.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      const at = performance.now()
      buffer += decoder.decode(next.value, { stream: true })
      let end = buffer.indexOf("\n\n")
      while (end >= 0) {
        const frame = frameOf(buffer.slice(0, end), at)
        buffer = buffer.slice(end + 2)
        if (frame) {
          frames.push(frame)
          for (const waiter of waiters) waiter(frame)
        }
        end = buffer.indexOf("\n\n")
      }
    }
  })().catch((error: unknown) => {
    failed = error
    refuse(error)
    for (const fail of failures) fail(error)
  })
  return {
    frames,
    opened,
    waitFor: (match, after, timeoutMs, label) => new Promise<TimedFrame>((resolve, reject) => {
      const found = frames.find((frame) => frame.at > after && match(frame))
      if (found) return resolve(found)
      if (failed) return reject(asError(failed))
      const timer = setTimeout(() => { done(); reject(new Error(`${label}: no frame within ${timeoutMs} ms; saw ${frames.slice(-8).map((frame) => frame.type).join(", ")}`)) }, timeoutMs)
      const waiter = (frame: TimedFrame) => { if (frame.at > after && match(frame)) { done(); resolve(frame) } }
      const fail = (error: unknown) => { done(); reject(asError(error)) }
      const done = () => { clearTimeout(timer); waiters.delete(waiter); failures.delete(fail) }
      waiters.add(waiter)
      failures.add(fail)
    }),
    close: () => controller.abort(),
  }
}

export type TurnTimes = {
  /** Every time is milliseconds after the press. */
  accepted: number
  firstDelta: number
  deltas: number[]
  idle: number
  lastDeltaToIdle: number
}

export type TurnMeasurementInput = {
  stream: TimedStream
  sessionId: string
  send: () => Promise<Response>
  timeoutMs?: number
}

const isDelta = (frame: TimedFrame, sessionId: string) => frame.type === "message.part.delta" && frame.sessionId === sessionId
const isIdle = (frame: TimedFrame, sessionId: string) => frame.type === "session.idle" && frame.sessionId === sessionId

/**
 * One turn as the person sees it: the press, the runtime's acceptance of the
 * prompt, the first streamed delta, every delta after it and the idle that ends
 * the turn, each as the time its frame reached the client.
 */
export async function measureTurn(input: TurnMeasurementInput): Promise<TurnTimes> {
  const timeoutMs = input.timeoutMs ?? 60_000
  const pressedAt = performance.now()
  const answer = await input.send()
  if (answer.status !== 204 && !answer.ok) throw new Error(`The prompt was refused: ${answer.status} ${await answer.text()}`)
  const accepted = performance.now() - pressedAt
  const first = await input.stream.waitFor((frame) => isDelta(frame, input.sessionId), pressedAt, timeoutMs, "first delta")
  const idle = await input.stream.waitFor((frame) => isIdle(frame, input.sessionId), first.at, timeoutMs, "idle after the turn")
  const deltas = input.stream.frames.filter((frame) => frame.at >= first.at && frame.at <= idle.at && isDelta(frame, input.sessionId)).map((frame) => frame.at - pressedAt)
  return { accepted, firstDelta: first.at - pressedAt, deltas, idle: idle.at - pressedAt, lastDeltaToIdle: idle.at - pressedAt - deltas[deltas.length - 1] }
}

export type TurnSummary = {
  turns: number
  accepted: Summary | undefined
  firstDelta: Summary | undefined
  interDelta: Summary | undefined
  lastDeltaToIdle: Summary | undefined
  idle: Summary | undefined
}

export function summarizeTurns(turns: readonly TurnTimes[]): TurnSummary {
  return {
    turns: turns.length,
    accepted: summarize(turns.map((turn) => turn.accepted)),
    firstDelta: summarize(turns.map((turn) => turn.firstDelta)),
    interDelta: summarize(turns.flatMap((turn) => intervals(turn.deltas))),
    lastDeltaToIdle: summarize(turns.map((turn) => turn.lastDeltaToIdle)),
    idle: summarize(turns.map((turn) => turn.idle)),
  }
}
