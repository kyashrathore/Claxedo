import { expect, test } from "bun:test"
import { listenForSessionDeletion } from "./session-deletion"

test("runtime deletion closes every matching saved surface without closing neighbors", () => {
  let receive!: Parameters<Parameters<typeof listenForSessionDeletion>[0]["listen"]>[0]
  let unsubscribed = false
  const surfaces = [
    { id: "tab", type: "session", sessionId: "removed", directory: "/workspace" },
    { id: "split", type: "context", sessionId: "removed", directory: "/workspace" },
    { id: "other", type: "session", sessionId: "neighbor", directory: "/workspace" },
    { id: "isolated", type: "session", sessionId: "removed", directory: "/other" },
    { id: "terminal", type: "terminal", sessionId: "removed", directory: "/workspace" },
  ]
  const stop = listenForSessionDeletion({
    listen(fn) { receive = fn; return () => { unsubscribed = true } },
    surfaces: () => [...surfaces],
    closeContent(id) { surfaces.splice(surfaces.findIndex((surface) => surface.id === id), 1) },
  })
  receive({ name: "/workspace", details: { type: "session.updated", properties: { info: { id: "removed" } } } })
  receive({ name: "global", details: { type: "session.deleted", properties: { info: { id: "removed" } } } })
  expect(surfaces).toHaveLength(5)
  receive({ name: "/workspace", details: { type: "session.deleted", properties: { info: { id: "removed" } } } })
  expect(surfaces.map((surface) => surface.id)).toEqual(["other", "isolated", "terminal"])
  receive({ name: "/workspace", details: { type: "session.deleted", properties: { info: { id: "removed" } } } })
  expect(surfaces).toHaveLength(3)
  stop()
  expect(unsubscribed).toBe(true)
})

test("a deleted session also evicts the workspace-panel tabs no surface owns", () => {
  let receive!: Parameters<Parameters<typeof listenForSessionDeletion>[0]["listen"]>[0]
  const evicted: string[] = []
  listenForSessionDeletion({
    listen(fn) { receive = fn; return () => {} },
    surfaces: () => [],
    closeContent() {},
    closeSubagentTabs(sessionId) { evicted.push(sessionId) },
  })
  receive({ name: "/workspace", details: { type: "session.updated", properties: { info: { id: "removed" } } } })
  expect(evicted).toEqual([])
  receive({ name: "/workspace", details: { type: "session.deleted", properties: { info: { id: "removed" } } } })
  expect(evicted).toEqual(["removed"])
})
