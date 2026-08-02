import { createComputed, createRoot } from "solid-js"
import { describe, expect, test } from "bun:test"
import { reviewWorkspaceActiveTab, setReviewWorkspaceActiveTab } from "./review-workspace-active-tab"

describe("review workspace active tab", () => {
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
})
