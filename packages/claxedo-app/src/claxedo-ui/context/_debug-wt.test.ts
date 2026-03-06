import { beforeAll, test } from "bun:test"
import { createRoot } from "solid-js"
import { ensureLayoutMocked, getInitLayout } from "./_test-helper"

let initLayout: () => any

beforeAll(async () => {
  await ensureLayoutMocked()
  initLayout = getInitLayout()
})

test("debug close tab worktree switch - check remaining items", () => {
  let dispose!: () => void
  const api = createRoot((d) => {
    dispose = d
    return initLayout()
  })
  try {
    api.split.toggle()
    const groups = api.split.groups()
    const g1 = groups[0].id
    const tabs1 = api.groupTabs(g1)
    const wt1 = api.groupWorktree(g1)

    const id1 = tabs1.addSession("/workspace-a", "s1", "Session A")
    tabs1.addSession("/workspace-b", "s2", "Session B")

    console.log("Before close:")
    console.log("  wt1.default():", wt1.default())
    console.log("  items dirs:", tabs1.items().map((t:any) => t.directory))
    console.log("  id1 tab:", tabs1.items().find((t:any) => t.id === id1))

    // Check: does closing work?
    const beforeItems = tabs1.items().length
    tabs1.close(id1)
    const afterItems = tabs1.items().length
    console.log("\nAfter close:")
    console.log("  items before:", beforeItems, "after:", afterItems)
    console.log("  wt1.default():", wt1.default())
    console.log("  remaining dirs:", tabs1.items().map((t:any) => t.directory))
    console.log("  activeId:", tabs1.activeId())
    console.log("  active tab:", tabs1.active())

    // Check if "/workspace-a" is still in remaining items
    const hasWorkspaceA = tabs1.items().some((t:any) => t.directory === "/workspace-a")
    console.log("  has /workspace-a in remaining:", hasWorkspaceA)
  } finally {
    dispose()
  }
})
