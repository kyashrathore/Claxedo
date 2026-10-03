/// <reference types="bun" />
import { expect, test } from "bun:test"
import { accountEvents, type AccountStreamPort } from "./account-events"

function streamingBridge() {
  const chunk = new Set<(payload: { streamId: string; text: string }) => void>()
  const end = new Set<(payload: { streamId: string }) => void>()
  const failure = new Set<(payload: { streamId: string; message: string }) => void>()
  const calls: unknown[][] = []
  const subscribe = <T>(listeners: Set<T>) => (listener: T) => (listeners.add(listener), () => void listeners.delete(listener))
  const bridge: AccountStreamPort = {
    streamOpen: async (operation, input) => (calls.push(["open", operation, input]), { streamId: "stream_1" }),
    streamStart: async (streamId) => void calls.push(["start", streamId]),
    streamClose: async (streamId) => void calls.push(["close", streamId]),
    onStreamChunk: subscribe(chunk),
    onStreamEnd: subscribe(end),
    onStreamError: subscribe(failure),
  }
  return {
    bridge,
    calls,
    chunk: (streamId: string, text: string) => chunk.forEach((listener) => listener({ streamId, text })),
    end: (streamId: string) => end.forEach((listener) => listener({ streamId })),
    fail: (streamId: string, message: string) => failure.forEach((listener) => listener({ streamId, message })),
    listening: () => chunk.size + end.size + failure.size,
  }
}

test("account events: opens the account's control-plane stream from its cursor and reads its own chunks until it ends", async () => {
  const fake = streamingBridge()
  const response = await accountEvents(fake.bridge)({ lastEventId: "12", signal: new AbortController().signal })

  expect(fake.calls).toEqual([["open", "controlPlane.events", { lastEventId: "12" }], ["start", "stream_1"]])
  fake.chunk("stream_other", "data: {}\n\n")
  fake.chunk("stream_1", "id: 13\ndata: {\"type\":\"session.status.changed\"}\n\n")
  fake.end("stream_1")

  expect(await response.text()).toBe("id: 13\ndata: {\"type\":\"session.status.changed\"}\n\n")
  expect(fake.listening()).toBe(0)
})

test("account events: a stream error fails the body, and an abort closes the stream in main", async () => {
  const fake = streamingBridge()
  const failed = await accountEvents(fake.bridge)({ signal: new AbortController().signal })
  fake.fail("stream_1", "session rejected")
  await expect(failed.text()).rejects.toThrow("session rejected")

  const aborted = new AbortController()
  await accountEvents(fake.bridge)({ signal: aborted.signal })
  aborted.abort()
  expect(fake.calls.at(-1)).toEqual(["close", "stream_1"])
  expect(fake.listening()).toBe(0)
})

test("account events: an abort while reading fails the read, so the stream reconnects, and closes the stream in main", async () => {
  const fake = streamingBridge()
  const aborted = new AbortController()
  const response = await accountEvents(fake.bridge)({ signal: aborted.signal })
  const reading = response.body!.getReader().read()

  aborted.abort(new Error("No heartbeat within the timeout"))

  await expect(reading).rejects.toThrow("No heartbeat within the timeout")
  expect(fake.calls.at(-1)).toEqual(["close", "stream_1"])
  expect(fake.listening()).toBe(0)
})

test("account events: an abort while the stream opens closes it in main and never starts it", async () => {
  const fake = streamingBridge()
  const aborted = new AbortController()
  const opened = Promise.withResolvers<unknown>()
  const bridge = { ...fake.bridge, streamOpen: (operation: string, input?: Readonly<Record<string, unknown>>) => (fake.calls.push(["open", operation, input]), opened.promise) }
  const opening = accountEvents(bridge)({ signal: aborted.signal })

  aborted.abort(new Error("closed"))
  opened.resolve({ streamId: "stream_1" })

  await expect(opening).rejects.toThrow("closed")
  expect(fake.calls).toEqual([["open", "controlPlane.events", {}], ["close", "stream_1"]])
  expect(fake.listening()).toBe(0)
})
