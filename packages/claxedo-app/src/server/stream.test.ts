/// <reference types="bun" />
import { afterEach, expect, jest, test } from "bun:test"
import { EVENT_STREAM_HEARTBEAT_MS } from "@claxedo/agent-runtime-contract"
import { openEventStream } from "./stream"
import { ServerError } from "./errors"

afterEach(() => {
  jest.useRealTimers()
})

async function settle() {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
}

function eventBody(frames: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame))
    },
  })
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

test("the stream keeps reconnecting past many failed attempts and re-reads the gap once it is back", async () => {
  jest.useFakeTimers()
  const failures = 25
  let opens = 0
  let gaps = 0
  const states: string[] = []
  const stream = openEventStream({
    open: async () => {
      opens += 1
      if (opens <= failures) throw new TypeError("fetch failed")
      return eventBody(['data: {"type":"stream.replay-gap"}\n\n'])
    },
    onFrame: () => undefined,
    onGap: () => {
      gaps += 1
    },
    onState: (state) => states.push(state.kind),
  })
  for (let step = 0; step < failures + 5; step += 1) {
    await settle()
    if (gaps > 0) break
    jest.advanceTimersByTime(15_000)
  }
  await settle()
  expect(opens).toBeGreaterThan(failures)
  expect(states).not.toContain("offline")
  expect(gaps).toBe(1)
  stream.close()
})

test("a stream outlives two missed heartbeats and a beat of jitter, and drops when the fourth beat is missed", async () => {
  jest.useFakeTimers()
  let push: (frame: string) => void = () => undefined
  const stream = openEventStream({
    open: async ({ signal }) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (frame) => controller.enqueue(new TextEncoder().encode(frame))
          signal.addEventListener("abort", () => controller.error(signal.reason))
        },
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
    onFrame: () => undefined,
    onGap: () => undefined,
  })
  const heartbeat = () => push('data: {"type":"heartbeat"}\n\n')
  await settle()
  heartbeat()
  await settle()
  jest.advanceTimersByTime(4 * EVENT_STREAM_HEARTBEAT_MS - 1)
  await settle()
  expect(stream.state().kind).toBe("connected")
  heartbeat()
  await settle()
  jest.advanceTimersByTime(4 * EVENT_STREAM_HEARTBEAT_MS - 1)
  await settle()
  expect(stream.state().kind).toBe("connected")
  jest.advanceTimersByTime(1)
  await settle()
  expect(stream.state()).toMatchObject({ kind: "reconnecting", afterLive: true })
  stream.close()
})

test.each([401, 403, 404])("a %i ends the stream: it reports the refusal once, goes offline and never reopens", async (status) => {
  jest.useFakeTimers()
  let opens = 0
  const refusals: Array<string | undefined> = []
  const stream = openEventStream({
    open: async () => {
      opens += 1
      return Response.json({ error: { code: "workspace_event_stream_denied", message: "denied" } }, { status })
    },
    onFrame: () => undefined,
    onGap: () => undefined,
    onRefused: (error) => refusals.push(error.code),
  })
  await settle()
  jest.advanceTimersByTime(60_000)
  await settle()
  stream.retry()
  await settle()
  expect(opens).toBe(1)
  expect(refusals).toEqual(["workspace_event_stream_denied"])
  expect(stream.state().kind).toBe("offline")
  stream.close()
})

test("an account port's auth refusal ends the stream even without an HTTP status", async () => {
  jest.useFakeTimers()
  let opens = 0
  const stream = openEventStream({
    open: async () => { opens++; throw new ServerError({ class: "auth", message: "The account is not signed in" }) },
    onFrame: () => undefined,
    onGap: () => undefined,
  })
  await settle()
  jest.advanceTimersByTime(60_000)
  await settle()
  expect(opens).toBe(1)
  expect(stream.state()).toEqual({ kind: "offline", reason: "The account is not signed in" })
  stream.close()
})
