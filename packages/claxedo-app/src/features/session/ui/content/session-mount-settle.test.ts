import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"

import { FIRST_FOLD_PREFETCH_JOIN_TIMEOUT_MS } from "@/features/session/store/first-fold-prefetch"
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
    createRoot((dispose) => {
      const [active, setActive] = createSignal(false)
      const settled = createSessionMountSettle({
        active,
        pendingTranscript: () => undefined,
      })
      expect(settled()).toBe(false)
      setActive(true)
      expect(settled()).toBe(true)
      dispose()
    })
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
    createRoot((dispose) => {
      const [pending, setPending] = createSignal<Promise<unknown> | undefined>(undefined)
      const settled = createSessionMountSettle({ active: () => true, pendingTranscript: pending })
      expect(settled()).toBe(true)
      setPending(new Promise(() => {}))
      expect(settled()).toBe(true)
      dispose()
    })
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
