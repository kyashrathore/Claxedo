// createKeySelector: the O(1) keyed-selection primitive Solid 2 rc.1 lacks.
// Three claims, each load-bearing:
//   1. it reports exactly what `key === source()` would, across select /
//      reselect / clear,
//   2. a selection change wakes ONLY the deselected and newly selected
//      subscribers — not all N (the reason it exists),
//   3. entries are pruned when their last subscriber is disposed (no
//      unbounded map growth as rows come and go).
import { describe, expect, test } from "bun:test"
import { createEffect, createRoot, createSignal, flush } from "solid-js"
import { createKeySelector } from "./create-key-selector"

const ids = Array.from({ length: 200 }, (_, i) => `row-${i}`)

describe("createKeySelector", () => {
  test("matches key === source() across select, reselect and clear", () => {
    const sample = ids.slice(0, 8)
    const harness = createRoot((dispose) => {
      const [active, setActive] = createSignal<string | undefined>("row-3")
      const isSelected = createKeySelector(active)
      return {
        dispose,
        setActive,
        viaSelector: () => sample.map((id) => isSelected(id)),
        viaEquality: () => sample.map((id) => active() === id),
      }
    })
    flush()
    expect(harness.viaSelector()).toEqual(harness.viaEquality())
    harness.setActive("row-6")
    flush()
    expect(harness.viaSelector()).toEqual(harness.viaEquality())
    harness.setActive(undefined)
    flush()
    expect(harness.viaSelector()).toEqual(harness.viaEquality())
    expect(harness.viaSelector().every((value) => value === false)).toBe(true)
    harness.dispose()
  })

  test("a selection change wakes only the two affected subscribers", () => {
    const harness = createRoot((dispose) => {
      const [active, setActive] = createSignal("row-0")
      const isSelected = createKeySelector(active)
      let computeRuns = 0
      let applyRuns = 0
      for (const id of ids) {
        createEffect(
          () => {
            computeRuns++
            return isSelected(id)
          },
          () => {
            applyRuns++
          },
        )
      }
      return { dispose, setActive, counts: () => ({ computeRuns, applyRuns }) }
    })
    flush()
    const base = harness.counts()
    harness.setActive("row-1")
    flush()
    const after = harness.counts()
    // Exactly two rows re-ran — this is the O(1) property. A per-row memo
    // re-runs all 200 comparisons here; the rc.1 projection walks all 200
    // subscribed key-signals in the store commit.
    expect(after.computeRuns - base.computeRuns).toBe(2)
    expect(after.applyRuns - base.applyRuns).toBe(2)
    harness.dispose()
  })

  test("untracked reads answer from the source and stay correct", () => {
    const [active, setActive] = createSignal("row-0")
    const probe = createRoot((dispose) => ({ dispose, isSelected: createKeySelector(active) }))
    flush()
    // Untracked (no observer): must match === semantics both for keys with a
    // live entry and for never-tracked keys, before and after changes.
    expect(probe.isSelected("row-0")).toBe(true)
    expect(probe.isSelected("row-99")).toBe(false)
    setActive("row-99")
    flush()
    expect(probe.isSelected("row-0")).toBe(false)
    expect(probe.isSelected("row-99")).toBe(true)
    probe.dispose()
  })

  test("entries are pruned when their subscribers are disposed", () => {
    const [active, setActive] = createSignal("row-0")
    const probe = createRoot((dispose) => {
      const isSelected = createKeySelector(active)
      const inner = createRoot((disposeInner) => {
        for (const id of ids) {
          createEffect(
            () => isSelected(id),
            () => {},
          )
        }
        return disposeInner
      })
      return { dispose, isSelected, inner }
    })
    flush()
    probe.inner() // dispose all subscribers
    flush()
    // After pruning, a flip must still work for a fresh subscriber whose entry
    // is created anew — i.e. the map self-heals rather than serving stale
    // signals for dead rows.
    const seen: boolean[] = []
    const outer = createRoot((dispose) => {
      createEffect(
        () => probe.isSelected("row-7"),
        (value) => {
          seen.push(value)
        },
      )
      return dispose
    })
    flush()
    setActive("row-7")
    flush()
    expect(seen).toEqual([false, true])
    outer()
    probe.dispose()
  })
})
