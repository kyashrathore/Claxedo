import { observeStream } from "./wire-corpus"

export type StreamFrame = { id?: string; event?: string; data: Record<string, unknown> }

export type EventStream = {
  readonly frames: StreamFrame[]
  waitFor(match: (frame: StreamFrame) => boolean, options: { label: string; timeoutMs?: number }): Promise<StreamFrame>
  close(): void
}

export type EventStreamOptions = { sessionId?: string; lastEventId?: string; workspaceId?: string; relayWorkspaceId?: string; authorization?: string }

function parseBlock(block: string): StreamFrame | undefined {
  let id: string | undefined
  let event: string | undefined
  const data: string[] = []
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim()
    else if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
  }
  if (!data.length) return undefined
  const text = data.join("\n")
  if (!text.startsWith("{")) return undefined
  return { ...(id ? { id } : {}), ...(event ? { event } : {}), data: JSON.parse(text) as Record<string, unknown> }
}

async function pump(body: ReadableStream<Uint8Array>, onFrame: (frame: StreamFrame) => void) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let at = buffer.indexOf("\n\n")
      while (at >= 0) {
        const frame = parseBlock(buffer.slice(0, at))
        buffer = buffer.slice(at + 2)
        if (frame) onFrame(frame)
        at = buffer.indexOf("\n\n")
      }
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) throw error
  }
}

export function frameType(frame: StreamFrame): string | undefined {
  const payload = frame.data.payload as { type?: unknown } | undefined
  return typeof payload?.type === "string" ? payload.type : typeof frame.data.type === "string" ? frame.data.type : undefined
}

export function frameSessionId(frame: StreamFrame): string | undefined {
  const payload = frame.data.payload as { properties?: { sessionID?: unknown; sessionId?: unknown } } | undefined
  const value = payload?.properties?.sessionID ?? payload?.properties?.sessionId
  return typeof value === "string" ? value : undefined
}

export async function openEventStream(url: string, directory: string, options: EventStreamOptions = {}): Promise<EventStream> {
  const target = new URL(options.relayWorkspaceId
    ? `/workspaces/${encodeURIComponent(options.relayWorkspaceId)}/api/wr/events`
    : "/api/wr/events", url)
  target.searchParams.set("directory", directory)
  if (options.workspaceId) target.searchParams.set("workspaceId", options.workspaceId)
  if (options.sessionId) target.searchParams.set("sessionID", options.sessionId)
  const controller = new AbortController()
  const response = await fetch(target, {
    headers: { accept: "text/event-stream", ...(options.lastEventId ? { "last-event-id": options.lastEventId } : {}), ...(options.authorization ? { authorization: options.authorization } : {}) },
    signal: controller.signal,
  })
  if (!response.ok || !response.body) throw new Error(`event stream refused: ${response.status} ${await response.text()}`)
  const frames: StreamFrame[] = []
  const listeners = new Set<(frame: StreamFrame) => void>()
  const recordFrame = observeStream(target)
  const droppedFrameType = process.env.CLAXEDO_E2E_DROP_FRAME_TYPE
  const failures = new Set<(error: unknown) => void>()
  let failure: { error: unknown } | undefined
  void pump(response.body, (frame) => {
    if (droppedFrameType && frameType(frame) === droppedFrameType) return
    recordFrame?.(frame)
    frames.push(frame)
    for (const listener of listeners) listener(frame)
  }).catch((error: unknown) => {
    failure = { error }
    for (const fail of failures) fail(error)
  })
  return {
    frames,
    waitFor: (match, waitOptions) =>
      new Promise<StreamFrame>((resolve, reject) => {
        const existing = frames.find(match)
        if (existing) return resolve(existing)
        if (failure) return reject(new Error(`event stream failed before ${waitOptions.label}: ${String(failure.error)}`, { cause: failure.error }))
        const done = () => {
          clearTimeout(timer)
          listeners.delete(listener)
          failures.delete(fail)
        }
        const timer = setTimeout(() => {
          done()
          reject(new Error(`event stream never delivered ${waitOptions.label} within ${waitOptions.timeoutMs ?? 30_000}ms`))
        }, waitOptions.timeoutMs ?? 30_000)
        const listener = (frame: StreamFrame) => {
          if (!match(frame)) return
          done()
          resolve(frame)
        }
        const fail = (error: unknown) => {
          done()
          reject(new Error(`event stream failed before ${waitOptions.label}: ${String(error)}`, { cause: error }))
        }
        listeners.add(listener)
        failures.add(fail)
      }),
    close: () => {
      controller.abort()
    },
  }
}
