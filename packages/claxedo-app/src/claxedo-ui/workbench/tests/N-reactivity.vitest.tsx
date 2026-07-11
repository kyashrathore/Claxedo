// Regression test for the WorkbenchProvider scratch-cache that broke
// reactive-subscription tracking on `getState()`.
//
// Theory under test: when a memo or effect first reads
// `state.wb.selectors.focusedContent()` *during* a synchronous burst of
// mutations (i.e. while `pendingLatest` is set inside WorkbenchProvider),
// the short-circuit `pendingLatest ?? props.state` returns the cached value
// without ever touching `props.state` — so SolidJS never registers a
// subscription on the upstream store for that memo. After the microtask
// flush clears `pendingLatest`, subsequent mutations don't re-trigger the
// memo, and downstream consumers (e.g. sidebar "active" highlights) freeze
// on the value last observed during the burst.
//
// This is exactly the live-browser dual-selected-sidebar pattern: clicking
// session A then session B leaves both rows highlighted, because the memo
// that maps focused content → active sidebar row stopped tracking the
// upstream after the second click.

import { describe, expect, test } from "vitest"
import { createEffect, createRoot, on } from "solid-js"
import { mountWorkbench, sleep } from "./dom-helpers"

describe("N. provider reactivity (subscription tracking)", () => {
  test("memo reading focusedContent re-runs on every external mutation", async () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().contents.add("c")

    // Subscribe to focusedContent via createEffect (the same primitive the
    // sidebar inventory and active-row memos use under the hood).
    const observed: (string | null)[] = []
    let dispose: (() => void) | undefined
    createRoot((d) => {
      dispose = d
      createEffect(
        on(
          () => h.api().selectors.focusedContent(),
          (value) => {
            observed.push(value)
          },
        ),
      )
    })
    await sleep(0)

    // Drive a burst of three sequential `show()` mutations with microtask
    // boundaries between them — what session-switching does in the wild
    // (each click happens in its own task, but a single click also issues
    // multiple chained `apply()` calls via `openSession` → `contents.add` +
    // `navigation.show`).
    h.api().navigation.show("a")
    await sleep(0)
    h.api().navigation.show("b")
    await sleep(0)
    h.api().navigation.show("c")
    await sleep(0)

    try {
      // Hard contract: the effect must have observed every distinct value
      // along the way. If subscription tracking is broken, "b" and "c"
      // will be missing because the effect stopped re-running after "a".
      expect(observed).toContain("a")
      expect(observed).toContain("b")
      expect(observed).toContain("c")
      // And the final observed value must be the latest mutation.
      expect(observed.at(-1)).toBe("c")
    } finally {
      dispose?.()
    }
  })

  test("memo re-runs even when first read happens during a burst", async () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().contents.add("c")

    // Same as above, but the effect is created *inside* a burst — this
    // mirrors the dynamic component scenario where a session row appears
    // mid-update (e.g. inventory rebuild during a click) and its memo's
    // first `getState()` happens while `pendingLatest` is set.
    const observed: (string | null)[] = []
    let dispose: (() => void) | undefined

    h.api().navigation.show("a")
    // Synchronously, inside the same task as the show() call, create the
    // tracker. This guarantees its first read happens before the microtask
    // can flush the scratch cache.
    createRoot((d) => {
      dispose = d
      createEffect(
        on(
          () => h.api().selectors.focusedContent(),
          (value) => {
            observed.push(value)
          },
        ),
      )
    })
    await sleep(0)

    // Continue mutating after the burst — the effect must still receive
    // updates.
    h.api().navigation.show("b")
    await sleep(0)
    h.api().navigation.show("c")
    await sleep(0)

    try {
      expect(observed).toContain("b")
      expect(observed).toContain("c")
      expect(observed.at(-1)).toBe("c")
    } finally {
      dispose?.()
    }
  })
})
