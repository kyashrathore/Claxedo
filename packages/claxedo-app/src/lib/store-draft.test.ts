import { describe, expect, test } from "bun:test"
import { createEffect, createStore, flush, storePath } from "solid-js"
import { createDraftReader } from "./store-draft"
import { mountReactive } from "./test-support/reactive-root"

type S = { meta: Record<string, { n: number }>; panel: { open: boolean; mode?: string } }

const setup = () => {
  const [store, setStore] = createStore<S>({ meta: { a: { n: 1 } }, panel: { open: false } })
  return { store, setStore, draft: createDraftReader<S>(setStore) }
}

describe("createDraftReader", () => {
  test("reads a value staged earlier in the same task", () => {
    const { store, setStore, draft } = setup()
    setStore(($state) => {
      $state.meta["a"].n = 42
    })
    expect(store.meta["a"].n).toBe(1) // the committed read is still the old value
    expect(draft(($state) => $state.meta["a"].n)).toBe(42)
    flush()
    expect(store.meta["a"].n).toBe(42)
  })

  test("sees staged key additions, deletions and storePath writes", () => {
    const { setStore, draft } = setup()
    setStore(($state) => {
      delete $state.meta["a"]
      $state.meta["b"] = { n: 2 }
    })
    setStore(storePath("panel", "mode", "review"))
    expect(draft(($state) => $state.meta["a"])).toBeUndefined()
    expect(draft(($state) => $state.meta["b"]?.n)).toBe(2)
    expect(draft(($state) => Object.keys($state.meta))).toEqual(["b"])
    expect(draft(($state) => $state.panel.mode)).toBe("review")
    flush()
  })

  test("a read-only callback stages nothing: no commit, no observer wake", () => {
    const { store, setStore, draft } = setup()
    let runs = 0
    // The effect tracks the STORE, the way a renderer does. Draft reads must be
    // invisible to it — the callback writes nothing, so it neither dirties a
    // node nor schedules a commit.
    const [, dispose] = mountReactive(() =>
      createEffect(
        () => {
          runs++
          return store.meta["a"].n
        },
        () => {},
      ),
    )

    try {
      flush()
      const before = runs
      for (let i = 0; i < 5; i++) expect(draft(($state) => $state.meta["a"].n)).toBe(1)
      flush()
      expect(runs).toBe(before)

      // A real write still wakes it, so the effect was live throughout.
      setStore(($state) => {
        $state.meta["a"].n = 99
      })
      flush()
      expect(runs).toBe(before + 1)
    } finally {
      dispose()
    }
  })

  test("a draft node that escapes its callback reads committed values again", () => {
    const { store, setStore, draft } = setup()
    setStore(($state) => {
      $state.meta["a"].n = 7
    })
    // Primitive: staged. Node: the same live proxy the committed read returns.
    expect(draft(($state) => $state.meta["a"].n)).toBe(7)
    expect(draft(($state) => ({ ...$state.meta["a"] })).n).toBe(7)
    expect(draft(($state) => $state.meta["a"]).n).toBe(1)
    flush()
    expect(store.meta["a"].n).toBe(7)
  })
})
