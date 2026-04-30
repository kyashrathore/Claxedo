/**
 * OpenCode EventSource — singleton SSE connection to opencode's /global/event stream.
 * Dispatches typed events to registered handlers with auto-reconnect.
 */

import { opencodeHeaders } from "./opencode-auth"

export type OpencodeEvent = {
  directory?: string
  payload: { type?: string; properties?: Record<string, unknown> }
}

export type OpencodeEventsHandle = {
  on(fn: (e: OpencodeEvent) => void): void
  off(fn: (e: OpencodeEvent) => void): void
  close(): void
}

export function createOpencodeEvents(opencodeUrl: string): OpencodeEventsHandle {
  const handlers = new Set<(e: OpencodeEvent) => void>()
  let abortController: AbortController | null = null
  let closed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectDelay = 1_000

  async function connect() {
    if (closed) return
    abortController = new AbortController()
    try {
      const res = await fetch(`${opencodeUrl}/global/event`, {
        headers: opencodeHeaders({ Accept: "text/event-stream" }),
        signal: abortController.signal,
      })
      if (!res.ok || !res.body) throw new Error(`Failed to connect to opencode events: ${res.status}`)
      reconnectDelay = 1_000 // reset on success

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          const raw = line.slice(6).trim()
          if (!raw) continue
          try {
            const data = JSON.parse(raw) as OpencodeEvent
            for (const handler of handlers) {
              try {
                handler(data)
              } catch {}
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    } catch (err) {
      if (closed) return
      if ((err as Error)?.name === "AbortError") return
      console.error("[opencode-events] connection lost, reconnecting in", reconnectDelay, "ms")
    }

    if (!closed) {
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
        connect()
      }, reconnectDelay)
    }
  }

  connect()

  return {
    on(fn: (e: OpencodeEvent) => void) {
      handlers.add(fn)
    },
    off(fn: (e: OpencodeEvent) => void) {
      handlers.delete(fn)
    },
    close() {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      abortController?.abort()
    },
  }
}
