export type StreamFrame = { id?: string; event?: string; data: Record<string, unknown> }

export type EventStream = {
  readonly frames: StreamFrame[]
  waitFor(match: (frame: StreamFrame) => boolean, options: { label: string; timeoutMs?: number }): Promise<StreamFrame>
  close(): void
}

export type EventStreamOptions = { sessionId?: string; lastEventId?: string }

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
  const target = new URL("/api/wr/events", url)
  target.searchParams.set("directory", directory)
  if (options.sessionId) target.searchParams.set("sessionID", options.sessionId)
  const controller = new AbortController()
  const response = await fetch(target, {
    headers: { accept: "text/event-stream", ...(options.lastEventId ? { "last-event-id": options.lastEventId } : {}) },
    signal: controller.signal,
  })
  if (!response.ok || !response.body) throw new Error(`event stream refused: ${response.status} ${await response.text()}`)
  const frames: StreamFrame[] = []
  const listeners = new Set<(frame: StreamFrame) => void>()
  const pumping = pump(response.body, (frame) => {
    frames.push(frame)
    for (const listener of listeners) listener(frame)
  })
  return {
    frames,
    waitFor: (match, waitOptions) =>
      new Promise<StreamFrame>((resolve, reject) => {
        const existing = frames.find(match)
        if (existing) return resolve(existing)
        const timer = setTimeout(() => {
          listeners.delete(listener)
          reject(new Error(`event stream never delivered ${waitOptions.label} within ${waitOptions.timeoutMs ?? 30_000}ms`))
        }, waitOptions.timeoutMs ?? 30_000)
        const listener = (frame: StreamFrame) => {
          if (!match(frame)) return
          clearTimeout(timer)
          listeners.delete(listener)
          resolve(frame)
        }
        listeners.add(listener)
      }),
    close: () => {
      controller.abort()
      void pumping
    },
  }
}
