import { createEffect, createSignal, flush } from "solid-js"
import { afterEach, describe, expect, test } from "bun:test"
import { reviewWorkspaceActiveTab, setReviewWorkspaceActiveTab } from "./review-workspace-active-tab"
import { mountReactive } from "@/lib/test-support/reactive-root"

describe("review workspace active tab", () => {
  afterEach(() => {
    setReviewWorkspaceActiveTab(undefined)
  })

  test("does not notify dependents for equivalent tab snapshots", () => {
    let runs = 0
    // The setter is a module-level signal the review workspace writes from its
    // effect, i.e. with no owner on the stack; only the observer needs one.
    const [, dispose] = mountReactive(() => {
      createEffect(
        () => reviewWorkspaceActiveTab(),
        () => {
          runs += 1
        },
      )
    })

    try {
      flush()

      flush(() => {
        setReviewWorkspaceActiveTab({ kind: "process", label: "dev-server" })
        setReviewWorkspaceActiveTab({ kind: "process", label: "dev-server" })
        setReviewWorkspaceActiveTab({ kind: "process", label: "dev-server" })
      })

      expect(runs).toBe(2)
    } finally {
      dispose()
    }
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

    const [, dispose] = mountReactive(() => {
      createEffect(
        () => generation(),
        () => {
          runs += 1
          setReviewWorkspaceActiveTab({ kind: "file", label: "file-7.ts", path: "src/generated/file-7.ts" })
        },
      )
      createEffect(
        () => generation(),
        () => {
          runs += 1
          setReviewWorkspaceActiveTab({ kind: "review", label: "Review" })
        },
      )
    })

    try {
      flush()
      expect(runs).toBe(2)

      flush(() => {
        setGeneration(1)
      })
      flush()

      expect(runs).toBe(4)
      expect(reviewWorkspaceActiveTab()?.kind).toBe("review")
    } finally {
      dispose()
    }
  })
})
