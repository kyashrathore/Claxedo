import { expect, test } from "bun:test"
import { ChangeCursorSchema } from "@claxedo/workgraph/contracts"
import { WorkGraphApiError } from "./api"
import { runWorkGraphSync, type ChangeWindow, type WorkGraphChangesPoll } from "./change-sync"

const cur = (value: string) => ChangeCursorSchema.parse(value)
// The synchronizer only reads `.changes.length` and `.cursor`; keep envelopes opaque.
const window = (cursor: string): ChangeWindow => ({ changes: [{}], cursor: cur(cursor), timedOut: false })
const empty = (cursor?: ChangeCursor | undefined): ChangeWindow => ({
  changes: [],
  ...(cursor ? { cursor } : {}),
  timedOut: true,
})
type ChangeCursor = ReturnType<typeof cur>

test("applies a change only after at least one empty timed-out poll", async () => {
  const controller = new AbortController()
  const polledAfter: Array<ChangeCursor | undefined> = []
  let reloads = 0
  const script = [empty(cur("0")), window("1")]
  const changes: WorkGraphChangesPoll = async (cursor) => {
    polledAfter.push(cursor)
    const next = script.shift()
    if (!next) {
      controller.abort()
      return empty(cursor)
    }
    return next
  }

  await runWorkGraphSync({
    changes,
    cursor: cur("0"),
    signal: controller.signal,
    waitMs: 25_000,
    reload: async () => {
      reloads++
      return cur("1")
    },
    onAdvance: () => {},
    onError: (error) => {
      throw error
    },
  })

  // The change was applied (one canonical reload) strictly after the first poll
  // returned empty+timed-out — never on the empty poll itself.
  expect(reloads).toBe(1)
  expect(polledAfter.slice(0, 2)).toEqual([cur("0"), cur("0")])
})

test("advances the cursor through ordered windows, applying each exactly once", async () => {
  const controller = new AbortController()
  const polledAfter: Array<ChangeCursor | undefined> = []
  let reloads = 0
  const script = [window("a"), window("b"), window("c")]
  const changes: WorkGraphChangesPoll = async (cursor) => {
    polledAfter.push(cursor)
    const next = script.shift()
    if (!next) {
      controller.abort()
      return empty(cursor)
    }
    return next
  }

  await runWorkGraphSync({
    changes,
    cursor: cur("seed"),
    signal: controller.signal,
    waitMs: 25_000,
    reload: async () => {
      reloads++
      return cur("snap")
    },
    onAdvance: () => {},
    onError: (error) => {
      throw error
    },
  })

  // One reload per distinct window (no double application), and each poll resumes
  // after the previous window's returned cursor — monotonic, never repeating.
  expect(reloads).toBe(3)
  expect(polledAfter.slice(0, 4)).toEqual([cur("seed"), cur("a"), cur("b"), cur("c")])
})

test("resets once on cursor_invalid and resumes from the reset snapshot cursor", async () => {
  const controller = new AbortController()
  const polledAfter: Array<ChangeCursor | undefined> = []
  let resets = 0
  const script: Array<() => ChangeWindow> = [
    () => {
      throw new WorkGraphApiError("cursor_invalid", "stale cursor")
    },
    () => empty(cur("fresh")),
  ]
  const changes: WorkGraphChangesPoll = async (cursor) => {
    polledAfter.push(cursor)
    const step = script.shift()
    if (!step) {
      controller.abort()
      return empty(cursor)
    }
    return step()
  }

  await runWorkGraphSync({
    changes,
    cursor: cur("stale"),
    signal: controller.signal,
    waitMs: 25_000,
    reload: async () => {
      resets++
      return cur("fresh")
    },
    onAdvance: () => {},
    onError: (error) => {
      throw new Error(`cursor_invalid must self-heal, not stall: ${error.message}`)
    },
  })

  // Exactly one canonical reset, and the poll after it resumes from the reset
  // snapshot's cursor rather than the rejected stale one.
  expect(resets).toBe(1)
  expect(polledAfter[0]).toBe(cur("stale"))
  expect(polledAfter[1]).toBe(cur("fresh"))
})

test("stops issuing requests once the signal is aborted", async () => {
  const controller = new AbortController()
  let calls = 0
  const changes: WorkGraphChangesPoll = (_cursor, options) => {
    calls++
    return new Promise<ChangeWindow>((resolve) =>
      options.signal.addEventListener("abort", () => resolve(empty()), { once: true }),
    )
  }

  const run = runWorkGraphSync({
    changes,
    cursor: cur("0"),
    signal: controller.signal,
    waitMs: 25_000,
    reload: async () => cur("0"),
    onAdvance: () => {},
    onError: (error) => {
      throw error
    },
  })
  // Let the first poll start, then abort it mid-flight.
  await Promise.resolve()
  controller.abort()
  await run

  // Only the in-flight poll was ever issued; the abort ended the loop with no
  // follow-up request.
  expect(calls).toBe(1)
})

test("stalls on an ordinary error and resumes only on an explicit retry", async () => {
  const controller = new AbortController()
  const errors: WorkGraphApiError[] = []
  let attempts = 0
  const changes: WorkGraphChangesPoll = async (cursor) => {
    attempts++
    if (attempts === 1) throw new WorkGraphApiError("offline", "WorkGraph is offline")
    controller.abort()
    return empty(cursor)
  }

  const config = {
    changes,
    cursor: cur("0"),
    signal: controller.signal,
    waitMs: 25_000,
    reload: async () => cur("0"),
    onAdvance: () => {},
    onError: (error: WorkGraphApiError) => errors.push(error),
  }

  // First run: the offline error stalls the loop after a single attempt — no
  // fallback snapshot, no auto-retry.
  await runWorkGraphSync(config)
  expect(attempts).toBe(1)
  expect(errors).toHaveLength(1)
  expect(errors[0].kind).toBe("offline")

  // The loop only resumes when explicitly re-run (the banner's Retry), then the
  // now-healthy endpoint lets it proceed.
  await runWorkGraphSync(config)
  expect(attempts).toBe(2)
})
