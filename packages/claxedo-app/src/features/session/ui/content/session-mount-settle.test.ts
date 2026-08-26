import { describe, expect, test } from "bun:test"
import { createRoot, createSignal, flush } from "solid-js"

import { FIRST_FOLD_PREFETCH_JOIN_TIMEOUT_MS } from "@/features/session/store/first-fold-prefetch"
import { mountReactive } from "@/lib/test-support/reactive-root"
import { createSessionMountSettle } from "./session-mount-settle"

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("createSessionMountSettle", () => {
  test("opens in the same pass when no transcript read is in flight", () => {
    createRoot((dispose) => {
      const settled = createSessionMountSettle({
        active: () => true,
        pendingTranscript: () => undefined,
      })
      // Read before any effect has had a chance to run: a warm switch must not
      // pay even one extra pass for a gate it does not need.
      expect(settled()).toBe(true)
      dispose()
    })
  })

  test("stays closed while the surface is not asked to render", () => {
    const [active, setActive] = createSignal(false)
    const [settled, dispose] = mountReactive(() =>
      createSessionMountSettle({
        active,
        pendingTranscript: () => undefined,
      }),
    )
    try {
      expect(settled()).toBe(false)
      // The activation is driven from outside the surface's owner, the way the
      // rail's click handler drives it, and settles before the gate is asked.
      setActive(true)
      flush()
      expect(settled()).toBe(true)
    } finally {
      dispose()
    }
  })

  test("holds construction until the transcript read settles", async () => {
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const { settled, dispose } = createRoot((dispose) => ({
      settled: createSessionMountSettle({ active: () => true, pendingTranscript: () => pending }),
      dispose,
    }))

    expect(settled()).toBe(false)
    await tick()
    expect(settled()).toBe(false)

    release!()
    await tick()
    expect(settled()).toBe(true)
    dispose()
  })

  test("a rejected read is still an answer", async () => {
    const pending = Promise.reject(new Error("superseded"))
    pending.catch(() => undefined)
    const { settled, dispose } = createRoot((dispose) => ({
      settled: createSessionMountSettle({ active: () => true, pendingTranscript: () => pending }),
      dispose,
    }))

    // The first read is what starts the wait — the real caller's `Show` takes
    // it in the pass that decides whether to construct the page.
    expect(settled()).toBe(false)
    await tick()
    expect(settled()).toBe(true)
    dispose()
  })

  test("latches: a read going in flight under a live page cannot re-close it", () => {
    const [pending, setPending] = createSignal<Promise<unknown> | undefined>(undefined)
    const [settled, dispose] = mountReactive(() =>
      createSessionMountSettle({ active: () => true, pendingTranscript: pending }),
    )
    try {
      expect(settled()).toBe(true)
      setPending(new Promise(() => {}))
      // Flushed, so the gate's memo has genuinely seen the new read and still
      // answers open — the latch, not a write that had not landed yet.
      flush()
      expect(settled()).toBe(true)
    } finally {
      dispose()
    }
  })

  test("a read that never settles still ends with a page, on the controller's own join budget", async () => {
    const { settled, dispose } = createRoot((dispose) => ({
      settled: createSessionMountSettle({ active: () => true, pendingTranscript: () => new Promise(() => {}) }),
      dispose,
    }))

    expect(settled()).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(settled()).toBe(true)
    dispose()
  })
})
