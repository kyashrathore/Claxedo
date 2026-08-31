import { afterEach, describe, expect, test } from "bun:test"

import { openAccountStreamResponse } from "./account-stream-fetch"

type Chunk = { streamId: string; text: string }
type End = { streamId: string }
type Failure = { streamId: string; message: string }

const originalApi = (globalThis as { api?: unknown }).api

afterEach(() => {
  if (originalApi === undefined) delete (globalThis as { api?: unknown }).api
  else (globalThis as { api?: unknown }).api = originalApi
})

function bridge(input: {
  onStart: (emit: {
    chunk: (payload: Chunk) => void
    end: (payload: End) => void
    error: (payload: Failure) => void
  }) => void | Promise<void>
}) {
  const chunks = new Set<(payload: Chunk) => void>()
  const ends = new Set<(payload: End) => void>()
  const errors = new Set<(payload: Failure) => void>()
  const closes: string[] = []
  let starts = 0
  const emit = {
    chunk: (payload: Chunk) => chunks.forEach((listener) => listener(payload)),
    end: (payload: End) => ends.forEach((listener) => listener(payload)),
    error: (payload: Failure) => errors.forEach((listener) => listener(payload)),
  }
  const account = {
    state: async () => ({ status: "signed" }),
    onState: () => () => {},
    signIn: async () => ({ status: "signed" }),
    signOut: async () => ({ status: "unsigned" }),
    run: async () => ({}),
    streamOpen: async () => ({ streamId: "stream_1" }),
    streamStart: async () => {
      starts++
      expect(chunks.size).toBe(1)
      expect(ends.size).toBe(1)
      expect(errors.size).toBe(1)
      await input.onStart(emit)
    },
    streamClose: async (streamId: string) => {
      closes.push(streamId)
    },
    onStreamChunk: (listener: (payload: Chunk) => void) => {
      chunks.add(listener)
      return () => chunks.delete(listener)
    },
    onStreamEnd: (listener: (payload: End) => void) => {
      ends.add(listener)
      return () => ends.delete(listener)
    },
    onStreamError: (listener: (payload: Failure) => void) => {
      errors.add(listener)
      return () => errors.delete(listener)
    },
  }
  ;(globalThis as { api?: unknown }).api = { account }
  return { closes, chunks, ends, errors, starts: () => starts }
}

describe("openAccountStreamResponse", () => {
  test("arms every listener before start so synchronous first chunk and end are preserved", async () => {
    const h = bridge({
      onStart: ({ chunk, end }) => {
        chunk({ streamId: "stream_1", text: "first frame" })
        end({ streamId: "stream_1" })
      },
    })

    const response = await openAccountStreamResponse({ operation: "session.events" })

    expect(await response.text()).toBe("first frame")
    expect(h.closes).toEqual(["stream_1"])
    expect(h.chunks.size).toBe(0)
    expect(h.ends.size).toBe(0)
    expect(h.errors.size).toBe(0)
  })

  test("preserves a synchronous terminal error emitted during start", async () => {
    const h = bridge({
      onStart: ({ error }) => {
        error({ streamId: "stream_1", message: "stream refused" })
      },
    })

    const response = await openAccountStreamResponse({ operation: "session.events" })

    await expect(response.text()).rejects.toThrow("stream refused")
    expect(h.closes).toEqual(["stream_1"])
    expect(h.chunks.size).toBe(0)
    expect(h.ends.size).toBe(0)
    expect(h.errors.size).toBe(0)
  })

  test("closes the reservation and listeners when start is rejected", async () => {
    const h = bridge({
      onStart: () => {
        throw new Error("unknown account stream")
      },
    })

    await expect(openAccountStreamResponse({ operation: "session.events" })).rejects.toThrow("unknown account stream")

    expect(h.closes).toEqual(["stream_1"])
    expect(h.chunks.size).toBe(0)
    expect(h.ends.size).toBe(0)
    expect(h.errors.size).toBe(0)
  })

  test("closes a reservation without starting when the caller is already aborted", async () => {
    const h = bridge({ onStart: () => {} })
    const abort = new AbortController()
    abort.abort(new Error("caller stopped"))

    await expect(openAccountStreamResponse({ operation: "session.events", signal: abort.signal })).rejects.toThrow(
      "caller stopped",
    )

    expect(h.starts()).toBe(0)
    expect(h.closes).toEqual(["stream_1"])
    expect(h.chunks.size).toBe(0)
    expect(h.ends.size).toBe(0)
    expect(h.errors.size).toBe(0)
  })
})
