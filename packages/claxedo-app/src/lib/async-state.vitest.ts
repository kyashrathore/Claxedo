import { createRoot, createSignal, flush } from "solid-js"
import { describe, expect, test } from "vitest"
import { createAsyncState } from "./async-state"

const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe("createAsyncState", () => {
  test("loads data and exposes pending state without suspending reads", async () => {
    let resolve!: (value: string) => void
    const pending = new Promise<string>((done) => {
      resolve = done
    })
    const state = createRoot(() => createAsyncState(() => pending))

    expect(state.loading()).toBe(true)
    expect(state.data()).toBeUndefined()
    resolve("ready")
    await settle()
    flush()
    expect(state.loading()).toBe(false)
    expect(state.data()).toBe("ready")
  })

  test("refreshes through the authoritative loader", async () => {
    let value = 0
    const state = createRoot(() => createAsyncState(async () => ++value))
    await settle()
    flush()
    expect(state.data()).toBe(1)

    state.refresh()
    await settle()
    flush()
    expect(state.data()).toBe(2)
  })

  test("preserves the last data when a refresh fails", async () => {
    let fail = false
    const state = createRoot(() =>
      createAsyncState(async () => {
        if (fail) throw new Error("offline")
        return "cached"
      }),
    )
    await settle()
    flush()
    fail = true
    state.refresh()
    await settle()
    flush()

    expect(state.data()).toBe("cached")
    expect(state.error()).toBeInstanceOf(Error)
  })

  test("mutates the exposed value without rerunning the loader", async () => {
    let loads = 0
    const state = createRoot(() => createAsyncState(async () => ++loads))
    await settle()
    flush()
    state.mutate(7)
    flush()

    expect(state.data()).toBe(7)
    expect(loads).toBe(1)
  })

  test("reloads when a tracked loader input changes", async () => {
    const [key, setKey] = createSignal("first")
    const state = createRoot(() => createAsyncState(async () => key()))
    await settle()
    flush()

    setKey("second")
    flush()
    expect(state.loading()).toBe(true)
    await settle()
    flush()

    expect(state.data()).toBe("second")
    expect(state.loading()).toBe(false)
  })

  test("keeps a mutation authoritative over an older in-flight load", async () => {
    let resolve!: (value: string) => void
    const pending = new Promise<string>((done) => {
      resolve = done
    })
    const state = createRoot(() => createAsyncState(() => pending))

    state.mutate("local")
    flush()
    resolve("stale")
    await settle()
    flush()

    expect(state.data()).toBe("local")
    expect(state.loading()).toBe(false)
  })

  test("a refresh keeps the last resolved value while the reload is in flight", async () => {
    // Stale-while-revalidate, matching Solid 1's createResource. ConnectionGate
    // gates the entire app shell on data(); a refresh that flickered the
    // accessor to undefined unmounted and remounted the whole workbench on the
    // first background health recovery.
    let value = "first"
    let release: (() => void) | undefined
    const state = createRoot(() =>
      createAsyncState(async () => {
        if (release) await new Promise<void>((done) => (release = done))
        return value
      }),
    )
    await settle()
    flush()
    expect(state.data()).toBe("first")

    value = "second"
    release = () => {}
    const refreshed = state.refresh()
    flush()
    await Promise.resolve()
    expect(state.data()).toBe("first")

    release()
    await refreshed
    await settle()
    flush()
    expect(state.data()).toBe("second")
    expect(state.loading()).toBe(false)
  })
})
