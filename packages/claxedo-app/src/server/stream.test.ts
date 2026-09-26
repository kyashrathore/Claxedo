/// <reference types="bun" />
import { afterEach, expect, jest, test } from "bun:test"
import { openStream } from "./stream"

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
  const stream = openStream({
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
