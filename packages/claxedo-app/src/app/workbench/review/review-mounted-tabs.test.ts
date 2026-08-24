import { describe, expect, test } from "bun:test"

import { reviewWorkspaceMountedTabs } from "./review-mounted-tabs"

const tabs = [
  { id: "review", kind: "review" },
  { id: "file:a", kind: "file" },
  { id: "file:b", kind: "file" },
  { id: "context", kind: "context" },
]

function mounted(activeTabId: string, pendingTabId?: string) {
  return reviewWorkspaceMountedTabs({ tabs, activeTabId, reviewTabId: "review", pendingTabId })
    .map((tab) => tab.id)
}

describe("review workspace mounted tabs", () => {
  test("mounts only the active tab", () => {
    expect(mounted("file:a")).toEqual(["file:a"])
    expect(mounted("context")).toEqual(["context"])
  })

  test("mounts nothing beside Review while Review is active", () => {
    expect(mounted("review")).toEqual([])
  })

  test("mounts a prepared tab alongside the active one until its activation commits", () => {
    // The frame between inserting a tab and activating it.
    expect(mounted("review", "file:b")).toEqual(["file:b"])
    expect(mounted("file:a", "file:b")).toEqual(["file:a", "file:b"])
    // Committed: the previous tab is gone the moment the new one is active.
    expect(mounted("file:b")).toEqual(["file:b"])
  })

  test("ignores a pending or active id the tab list no longer has", () => {
    expect(mounted("file:gone", "file:also-gone")).toEqual([])
  })
})
