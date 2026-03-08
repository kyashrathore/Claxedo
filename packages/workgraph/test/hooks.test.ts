import { describe, test, expect } from "bun:test"
import { onComplete } from "../src/hooks"
import type { WorkItem } from "../src/types"
import type { ConnectorInterface } from "@opencode-ai/orchestrator-events"

function makeItem(overrides?: Partial<WorkItem>): WorkItem {
  return {
    id: crypto.randomUUID(),
    title: "Test Item",
    description: "",
    status: "open",
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function mockConnector(overrides?: Partial<ConnectorInterface>): ConnectorInterface {
  return {
    provider: "mock",
    hydrateIssue: async () => ({ id: "1", title: "t", description: "", status: "open" as const, provider_url: "" }),
    updateIssue: async () => {},
    addComment: async () => {},
    createIssue: async () => ({ id: "1", title: "t", description: "", status: "open" as const, provider_url: "" }),
    ...overrides,
  }
}

describe("onComplete hooks", () => {
  test("pushes comment to downstream items with providerMeta", async () => {
    const comments: Array<{ params: any; comment: string }> = []
    const connector = mockConnector({
      addComment: async (params, comment) => { comments.push({ params, comment }) },
    })

    const completed = makeItem({ title: "Auth Service", status: "done" })
    const downstream = [
      makeItem({ providerMeta: { owner: "acme", issueNumber: 1 } }),
      makeItem({ providerMeta: { owner: "acme", issueNumber: 2 } }),
    ]

    const actions = await onComplete(
      completed,
      downstream,
      () => [completed],
      connector,
    )

    expect(comments).toHaveLength(2)
    expect(comments[0].comment).toContain("Auth Service")
    expect(actions.filter((a) => a.action === "comment_added")).toHaveLength(2)
  })

  test("updates status when all blockers are done", async () => {
    const statusUpdates: any[] = []
    const connector = mockConnector({
      updateIssue: async (params, updates) => { statusUpdates.push({ params, ...updates }) },
    })

    const completed = makeItem({ status: "done" })
    const downstream = [
      makeItem({ providerMeta: { issueNumber: 1 } }),
    ]

    const actions = await onComplete(
      completed,
      downstream,
      () => [makeItem({ status: "done" })],
      connector,
    )

    expect(statusUpdates).toHaveLength(1)
    expect(statusUpdates[0].status).toBe("open")
    expect(actions.some((a) => a.action === "status_unblocked")).toBe(true)
  })

  test("does not update status when blockers remain", async () => {
    const statusUpdates: any[] = []
    const connector = mockConnector({
      updateIssue: async (params, updates) => { statusUpdates.push(updates) },
    })

    const completed = makeItem({ status: "done" })
    const downstream = [
      makeItem({ providerMeta: { issueNumber: 1 } }),
    ]

    await onComplete(
      completed,
      downstream,
      () => [makeItem({ status: "done" }), makeItem({ status: "open" })],
      connector,
    )

    expect(statusUpdates).toHaveLength(0)
  })

  test("returns empty actions when no connector", async () => {
    const completed = makeItem({ status: "done" })
    const downstream = [makeItem({ providerMeta: { x: 1 } })]

    const actions = await onComplete(completed, downstream, () => [], undefined)
    expect(actions).toHaveLength(0)
  })

  test("skips items without providerMeta", async () => {
    const comments: string[] = []
    const connector = mockConnector({
      addComment: async (_, c) => { comments.push(c) },
    })

    const completed = makeItem({ status: "done" })
    const downstream = [
      makeItem(),  // no providerMeta
      makeItem({ providerMeta: { issueNumber: 1 } }),
    ]

    await onComplete(
      completed,
      downstream,
      () => [makeItem({ status: "done" })],
      connector,
    )

    expect(comments).toHaveLength(1)
  })

  test("connector addComment error does not throw", async () => {
    const connector = mockConnector({
      addComment: async () => { throw new Error("network error") },
    })

    const completed = makeItem({ status: "done" })
    const downstream = [makeItem({ providerMeta: { issueNumber: 1 } })]

    const actions = await onComplete(completed, downstream, () => [completed], connector)
    // addComment failed → no comment_added, but updateIssue still succeeds → status_unblocked
    expect(actions.filter((a) => a.action === "comment_added")).toHaveLength(0)
    expect(actions.filter((a) => a.action === "status_unblocked")).toHaveLength(1)
  })

  test("connector updateIssue error does not throw", async () => {
    const connector = mockConnector({
      addComment: async () => {},
      updateIssue: async () => { throw new Error("network error") },
    })

    const completed = makeItem({ status: "done" })
    const downstream = [makeItem({ providerMeta: { issueNumber: 1 } })]

    const actions = await onComplete(
      completed,
      downstream,
      () => [makeItem({ status: "done" })],
      connector,
    )

    // comment succeeded but status update failed
    expect(actions.filter((a) => a.action === "comment_added")).toHaveLength(1)
    expect(actions.filter((a) => a.action === "status_unblocked")).toHaveLength(0)
  })

  test("handles empty downstream list", async () => {
    const connector = mockConnector()
    const completed = makeItem({ status: "done" })
    const actions = await onComplete(completed, [], () => [], connector)
    expect(actions).toHaveLength(0)
  })
})
