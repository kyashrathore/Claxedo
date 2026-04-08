import { streamSSE } from "hono/streaming"
import { claxedoBus, globalBus, type GlobalEvent } from "../bus"
import type { Context } from "hono"

export async function eventsHandler(c: Context) {
  return streamSSE(c, async (stream) => {
    const unsub = claxedoBus.subscribe((event) => {
      void stream.writeSSE({ data: JSON.stringify(event) })
    })

    const hb = setInterval(() => {
      void stream.writeSSE({ data: JSON.stringify({ type: "heartbeat" }) })
    }, 30000)

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(hb)
        unsub()
        resolve()
      })
    })
  })
}

function global(data: GlobalEvent) {
  return {
    directory: data.directory ?? "global",
    payload: data.payload,
  }
}

export async function globalEventsHandler(c: Context) {
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      data: JSON.stringify(global({
        directory: "global",
        payload: {
          type: "server.connected",
          properties: {},
        },
      })),
    })

    const unsub = globalBus.subscribe((event) => {
      void stream.writeSSE({ data: JSON.stringify(global(event)) })
    })

    const hb = setInterval(() => {
      void stream.writeSSE({
        data: JSON.stringify(global({
          directory: "global",
          payload: {
            type: "server.heartbeat",
            properties: {},
          },
        })),
      })
    }, 10_000)

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(hb)
        unsub()
        resolve()
      })
    })
  })
}
