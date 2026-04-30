import { streamSSE } from "hono/streaming"
import { claxedoBus } from "../bus"
import type { Context } from "hono"

export async function eventsHandler(c: Context) {
  return streamSSE(c, async (stream) => {
    const unsub = claxedoBus.subscribe((event) => {
      void stream.writeSSE({ data: JSON.stringify(event) })
    })

    const hb = setInterval(() => {
      void stream.writeSSE({ data: JSON.stringify({ type: "heartbeat" }) })
    }, 2 * 60_000)

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(hb)
        unsub()
        resolve()
      })
    })
  })
}
