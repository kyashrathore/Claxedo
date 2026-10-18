/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createPrefetchGate, createSettledPrefetch, type QuietMoment } from "./prefetch"

function moments() {
  const queued: Array<() => void> = []
  let waiting = 0
  const quiet: QuietMoment = (run) => {
    let live = true
    waiting += 1
    queued.push(() => {
      if (!live) return
      live = false
      waiting -= 1
      run()
    })
    return () => {
      if (!live) return
      live = false
      waiting -= 1
    }
  }
  return { quiet, waiting: () => waiting, arrive: () => queued.splice(0).forEach((run) => run()) }
}

function loads() {
  let count = 0
  return { load: () => Promise.resolve(++count), count: () => count }
}

test("with nothing loading, a prefetch waits for the next quiet moment and loads once", async () => {
  await createRoot(async (dispose) => {
    const gate = createPrefetchGate()
    const clock = moments()
    const fetched = loads()
    createSettledPrefetch(gate, fetched.load, "prefetch failed", clock.quiet)
    await Promise.resolve()
    expect(clock.waiting()).toBe(1)
    expect(fetched.count()).toBe(0)
    clock.arrive()
    await Promise.resolve()
    expect(fetched.count()).toBe(1)
    expect(clock.waiting(), "a loaded prefetch asks for no further moment").toBe(0)
    dispose()
  })
})

test("a screen's first reads hold every prefetch until they land", async () => {
  await createRoot(async (dispose) => {
    const gate = createPrefetchGate()
    const clock = moments()
    const fetched = loads()
    const [loading, setLoading] = createSignal(true)
    gate.hold(loading)
    createSettledPrefetch(gate, fetched.load, "prefetch failed", clock.quiet)
    await Promise.resolve()
    expect(clock.waiting(), "no moment is asked for while the first page loads").toBe(0)
    setLoading(false)
    expect(clock.waiting()).toBe(1)
    clock.arrive()
    await Promise.resolve()
    expect(fetched.count()).toBe(1)
    dispose()
  })
})

test("a hold taken before the quiet moment arrives cancels it, and the prefetch waits for the release", async () => {
  await createRoot(async (dispose) => {
    const gate = createPrefetchGate()
    const clock = moments()
    const fetched = loads()
    createSettledPrefetch(gate, fetched.load, "prefetch failed", clock.quiet)
    await Promise.resolve()
    expect(clock.waiting()).toBe(1)
    const release = gate.hold(() => true)
    expect(clock.waiting(), "the moment asked for before the hold is cancelled").toBe(0)
    clock.arrive()
    await Promise.resolve()
    expect(fetched.count()).toBe(0)
    release()
    expect(clock.waiting()).toBe(1)
    clock.arrive()
    await Promise.resolve()
    expect(fetched.count()).toBe(1)
    dispose()
  })
})

test("a hold taken after the prefetch loaded fetches nothing again", async () => {
  await createRoot(async (dispose) => {
    const gate = createPrefetchGate()
    const clock = moments()
    const fetched = loads()
    createSettledPrefetch(gate, fetched.load, "prefetch failed", clock.quiet)
    await Promise.resolve()
    clock.arrive()
    await Promise.resolve()
    const release = gate.hold(() => true)
    release()
    clock.arrive()
    await Promise.resolve()
    expect(fetched.count()).toBe(1)
    expect(clock.waiting()).toBe(0)
    dispose()
  })
})
