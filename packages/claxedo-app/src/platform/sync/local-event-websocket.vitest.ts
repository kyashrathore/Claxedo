import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { openLocalEventWebSocket } from "./local-event-websocket"

class Socket {
  static instances: Socket[] = []
  binaryType = "blob"
  onopen?: () => void
  onmessage?: (event: { data: string | ArrayBuffer }) => void
  onerror?: () => void
  onclose?: (event: { code: number }) => void
  close = vi.fn()
  constructor(readonly url: URL) { Socket.instances.push(this) }
}
beforeEach(() => { Socket.instances = []; vi.stubGlobal("WebSocket", Socket) })
afterEach(() => vi.unstubAllGlobals())

test("carries the exact SSE bytes and resume cursor, and aborts the reader", async () => {
  const abort = new AbortController()
  const response = openLocalEventWebSocket(new URL("http://127.0.0.1/api/cp/events"), { headers: { "Last-Event-ID": "17" }, signal: abort.signal })
  const socket = Socket.instances[0]
  expect(socket.url.href).toBe("ws://127.0.0.1/api/cp/events?lastEventId=17")
  expect(socket.binaryType).toBe("arraybuffer")
  socket.onopen!()
  const reader = (await response).body!.getReader()
  const frame = 'id: 18\ndata: {"type":"session.updated"}\n\n'
  socket.onmessage!({ data: new TextEncoder().encode(frame).buffer })
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(frame)
  abort.abort()
  await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" })
  expect(socket.close).toHaveBeenCalledTimes(1)
})

test("reader cancellation closes the socket without a later abort double-closing it", async () => {
  const abort = new AbortController()
  const response = openLocalEventWebSocket(new URL("http://127.0.0.1/api/cp/events"), { signal: abort.signal })
  const socket = Socket.instances[0]
  socket.onopen!()
  await (await response).body!.cancel()
  abort.abort()
  socket.onmessage!({ data: "late data" })
  expect(socket.close).toHaveBeenCalledTimes(1)
})

test("handshake failure rejects instead of pretending that a stream opened", async () => {
  const response = openLocalEventWebSocket(new URL("http://127.0.0.1/api/cp/events"))
  Socket.instances[0].onerror!()
  await expect(response).rejects.toThrow("Local event WebSocket failed")
})

test("a clean server close ends the body, while an abnormal close rejects the reader", async () => {
  for (const code of [1000, 1006]) {
    const response = openLocalEventWebSocket(new URL("http://127.0.0.1/api/cp/events"))
    const socket = Socket.instances.at(-1)!
    socket.onopen!()
    const reader = (await response).body!.getReader()
    socket.onclose!({ code })
    if (code === 1000) expect((await reader.read()).done).toBe(true)
    else await expect(reader.read()).rejects.toThrow("1006")
  }
})
