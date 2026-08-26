import { createComputed, createEffect, createRoot, createSignal } from "solid-js"
import { afterEach, describe, expect, test } from "bun:test"
import { reviewWorkspaceActiveTab, setReviewWorkspaceActiveTab } from "./review-workspace-active-tab"

describe("review workspace active tab", () => {
  afterEach(() => {
    setReviewWorkspaceActiveTab(undefined)
  })

  test("does not notify dependents for equivalent tab snapshots", () => {
    createRoot((dispose) => {
      let runs = 0
      createComputed(() => {
        reviewWorkspaceActiveTab()
        runs += 1
      })

      setReviewWorkspaceActiveTab({ kind: "process", label: "dev-server" })
      setReviewWorkspaceActiveTab({ kind: "process", label: "dev-server" })
      setReviewWorkspaceActiveTab({ kind: "process", label: "dev-server" })

      expect(runs).toBe(2)
      dispose()
    })
  })

  // The shape the workspace panel has whenever it retains a second body: two
  // live publishers, each publishing a DIFFERENT tab from its own effect. A
  // write guard that READS the signal makes every publisher a dependent of its
  // own writes, so the two re-trigger each other with no fixed point and the
  // update phase nests one `runUpdates` per generation until the stack is
  // exhausted ("RangeError: Maximum call stack size exceeded").
  test("two publishers of different tabs settle instead of re-triggering each other", () => {
    const [generation, setGeneration] = createSignal(0)
    let runs = 0
    let dispose: VoidFunction = () => {}

    createRoot((disposeRoot) => {
      dispose = disposeRoot
      createEffect(() => {
        generation()
        runs += 1
        setReviewWorkspaceActiveTab({ kind: "file", label: "file-7.ts", path: "src/generated/file-7.ts" })
      })
      createEffect(() => {
        generation()
        runs += 1
        setReviewWorkspaceActiveTab({ kind: "review", label: "Review" })
      })
    })

    expect(runs).toBe(2)

    setGeneration(1)

    expect(runs).toBe(4)
    expect(reviewWorkspaceActiveTab()?.kind).toBe("review")
    dispose()
  })
})
