import { describe, expect, test } from "bun:test"
import { sendWebSocketWithBackpressure, type WebSocketBackpressureSocket } from "./websocket-backpressure"

function socket(input: {
  bufferedAmount?: number
  send?: (data: string | Uint8Array | ArrayBuffer) => void
} = {}) {
  const sent: Array<string | Uint8Array | ArrayBuffer> = []
  const closed: Array<{ code?: number; reason?: string }> = []
  return {
    sent,
    closed,
    ws: {
      readyState: 1,
      bufferedAmount: input.bufferedAmount,
      send(data) {
        if (input.send) return input.send(data)
        sent.push(data)
      },
      close(code, reason) {
        closed.push({ code, reason })
      },
    } satisfies WebSocketBackpressureSocket,
  }
}

describe("sendWebSocketWithBackpressure", () => {
  test("sends while the buffered amount is within the limit", () => {
    const target = socket({ bufferedAmount: 8 })

    const sent = sendWebSocketWithBackpressure(target.ws, "hello", { maxBufferedBytes: 10 })

    expect(sent).toBe(true)
    expect(target.sent).toEqual(["hello"])
    expect(target.closed).toEqual([])
  })

  test("closes slow consumers before adding more buffered data", () => {
    const target = socket({ bufferedAmount: 11 })

    const sent = sendWebSocketWithBackpressure(target.ws, "hello", { maxBufferedBytes: 10 })

    expect(sent).toBe(false)
    expect(target.sent).toEqual([])
    expect(target.closed).toEqual([{ code: 1013, reason: "WebSocket backpressure limit exceeded" }])
  })

  test("closes sockets that throw while sending", () => {
    const target = socket({
      send() {
        throw new Error("closed")
      },
    })

    const sent = sendWebSocketWithBackpressure(target.ws, "hello", { maxBufferedBytes: 10 })

    expect(sent).toBe(false)
    expect(target.closed).toEqual([{ code: undefined, reason: undefined }])
  })
})
