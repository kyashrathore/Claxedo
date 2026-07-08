import { randomUUID } from "crypto"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import { globalBus } from "../bus"

export function streamGlobalEvents(c: Context) {
  const normalizeEvent = (event: Parameters<Parameters<typeof globalBus.subscribe>[0]>[0]) => {
    const payload = event.payload as typeof event.payload & { id?: unknown }
    return {
      ...event,
      directory: event.directory ?? "global",
      payload: {
        id: typeof payload.id === "string" ? payload.id : randomUUID(),
        properties: {},
        ...event.payload,
      },
    }
  }
  return streamSSE(c, async (stream) => {
    const writeHeartbeat = () =>
      stream.writeSSE({
        data: JSON.stringify({
          directory: "global",
          payload: { id: randomUUID(), type: "server.connected", properties: {} },
        }),
      })
    const unsubscribe = globalBus.subscribe((event) => {
      void stream.writeSSE({ data: JSON.stringify(normalizeEvent(event)) })
    })
    void writeHeartbeat()
    const heartbeat = setInterval(() => {
      void writeHeartbeat()
    }, 5000)

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(heartbeat)
        unsubscribe()
        resolve()
      })
    })
  })
}
