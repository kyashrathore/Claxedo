import type { Context } from "hono"
import type { createNodeWebSocket } from "@hono/node-ws"
import { SSEStreamingApi, streamSSE } from "hono/streaming"

type UpgradeWebSocket = ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"]

/** Carry the same authorized SSE writer over HTTP or a local WebSocket. */
export async function eventStreamResponse(
  c: Context,
  write: (stream: SSEStreamingApi) => Promise<void>,
  upgradeWebSocket?: UpgradeWebSocket,
) {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return streamSSE(c, write)
  const origin = c.req.header("origin")
  if (origin && origin !== connectedOrigin(c) && c.res.headers.get("Access-Control-Allow-Origin") !== origin) {
    return c.json({ error: "Event WebSocket origin is not allowed" }, 403)
  }
  if (!upgradeWebSocket) return c.json({ error: "WebSocket event transport is unavailable" }, 501)
  const response = await upgradeWebSocket(() => {
    let stream: SSEStreamingApi | undefined
    return {
      onOpen(_event, socket) {
        const raw = socket.raw
        if (!raw) { socket.close(1011, "Missing event transport socket"); return }
        const pipe = new TransformStream<Uint8Array, Uint8Array>()
        stream = new SSEStreamingApi(pipe.writable, pipe.readable)
        const active = stream
        const reader = active.responseReadable.getReader()
        active.onAbort(() => { socket.close() })
        void write(active).catch(() => active.abort()).finally(() => active.close())
        void (async () => {
          try {
            for (;;) {
              const next = await reader.read()
              if (next.done) break
              await new Promise<void>((resolve, reject) => {
                raw.send(next.value, (error) => error ? reject(error) : resolve())
              })
            }
          } finally {
            active.abort()
            await reader.cancel().catch(() => {})
            socket.close()
          }
        })().catch(() => {})
      },
      onClose() { stream?.abort() },
      onError() { stream?.abort() },
    }
  })(c, async () => {})
  if (!response) throw new Error("Event WebSocket upgrade returned no response")
  return response
}

export type { UpgradeWebSocket }

// `@hono/node-ws` resolves an upgrade's URL against a fixed `http://localhost`
// base, so on that path `c.req.url` never carries the port the client
// connected to; the Host header does.
function connectedOrigin(c: Context) {
  const url = new URL(c.req.url)
  const host = c.req.header("host")
  return host ? `${url.protocol}//${host}` : url.origin
}
