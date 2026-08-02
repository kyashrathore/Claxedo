/**
 * OpenCode EventSource — singleton SSE connection to opencode's /global/event stream.
 * Dispatches typed events to registered handlers with auto-reconnect.
 *
 * Rides the injected transport (`opencodeRequest`) rather than a URL: in
 * embedded mode this streams SSE directly from the in-process engine handler;
 * in external-url mode it rewrites onto the configured URL and fetches.
 */

import type { OpenCodeRequestFn } from "@claxedo/agent-sdk-runtime/adapters"
import { OPENCODE_INTERNAL_BASE } from "./opencode-engine"

export type OpencodeEvent = {
  directory?: string
  payload: { type?: string; properties?: Record<string, unknown> }
}

export type OpencodeEventsHandle = {
  on(fn: (e: OpencodeEvent) => void): void
  off(fn: (e: OpencodeEvent) => void): void
  start(): void
  close(): void
}

export function createOpencodeEvents(
  request: OpenCodeRequestFn,
  options: { autoStart?: boolean } = {},
): OpencodeEventsHandle {
  const handlers = new Set<(e: OpencodeEvent) => void>()
  let abortController: AbortController | null = null
  let closed = false
  let started = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectDelay = 1_000

  async function connect() {
    if (closed) return
    abortController = new AbortController()
    try {
      const res = await request(
        new Request(`${OPENCODE_INTERNAL_BASE}/global/event`, {
          headers: { Accept: "text/event-stream" },
          signal: abortController.signal,
        }),
      )
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

  function start() {
    if (closed || started) return
    started = true
    connect()
  }

  if (options.autoStart !== false) start()

  return {
    on(fn: (e: OpencodeEvent) => void) {
      handlers.add(fn)
    },
    off(fn: (e: OpencodeEvent) => void) {
      handlers.delete(fn)
    },
    start,
    close() {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      abortController?.abort()
    },
  }
}
