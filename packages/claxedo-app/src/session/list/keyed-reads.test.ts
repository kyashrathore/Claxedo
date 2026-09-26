/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createMemo, createRoot, createSignal } from "solid-js"
import { createKeyedReads } from "./keyed-reads"

function harness() {
  const alpha = { title: "Alpha" }
  const bravo = { title: "Bravo" }
  const [source, setSource] = createSignal<ReadonlyMap<string, { title: string }>>(new Map([["a", alpha], ["b", bravo]]))
  const runs = { a: 0, b: 0 }
  const reads = createKeyedReads(source)
  const readA = createMemo(() => {
    runs.a += 1
    return reads("a")?.title
  })
  const readB = createMemo(() => {
    runs.b += 1
    return reads("b")?.title
  })
  readA()
  readB()
  return { alpha, bravo, setSource, runs, readA, readB, reads }
}

test("keyed reads: a change to one key re-runs only that key's readers", () => {
  createRoot((dispose) => {
    const state = harness()
    state.setSource(new Map([["a", { title: "Alpha renamed" }], ["b", state.bravo]]))
    expect(state.readA()).toBe("Alpha renamed")
    expect(state.readB()).toBe("Bravo")
    expect(state.runs).toEqual({ a: 2, b: 1 })
    dispose()
  })
})

test("keyed reads: a new map with the same values re-runs no reader", () => {
  createRoot((dispose) => {
    const state = harness()
    state.setSource(new Map([["a", state.alpha], ["b", state.bravo]]))
    expect(state.runs).toEqual({ a: 1, b: 1 })
    dispose()
  })
})

test("keyed reads: a key that leaves reads undefined, and an untracked read answers the current value", () => {
  createRoot((dispose) => {
    const state = harness()
    state.setSource(new Map([["b", state.bravo]]))
    expect(state.readA()).toBeUndefined()
    expect(state.runs).toEqual({ a: 2, b: 1 })
    state.setSource(new Map([["a", { title: "Alpha again" }], ["b", state.bravo]]))
    expect(state.reads("a")?.title).toBe("Alpha again")
    dispose()
  })
})
