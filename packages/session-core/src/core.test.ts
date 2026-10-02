import { expect, test } from "bun:test"
import { createSessionCore } from "./index"

function core() {
  return createSessionCore({ placement: {
    workspaceId: "ws_same", directory: "/workspace", normalizeDirectory: (value) => value, canonicalDirectory: (value) => value,
    containsDirectory: (root, value) => value === root || value.startsWith(`${root}/`),
    sessionIdWorkspace: () => undefined,
  } })
}

test("one core instance's control frames never reach another instance", () => {
  const first = core(), second = core()
  const seen: unknown[] = []
  const stop = second.bus.subscribe((event) => seen.push(event))
  first.bus.publish({ type: "pty.deleted", id: "one" })
  stop()
  expect(seen).toEqual([])
})

test("two core instances of the same workspace own separate placement registries", () => {
  const first = core(), second = core()
  first.placement.register({ sessionId: "child", directory: "/worktrees/child" })
  expect(second.placement.registeredDirectory("child")).toBeUndefined()
})

test("the placement serves its root, its synthetic workspace name and registered worktrees, and refuses any other directory", () => {
  const { placement } = core()
  placement.register({ sessionId: "child", directory: "/worktrees/child" })
  expect([undefined, "/workspace", "workspace:ws_same", "/worktrees/child"].map((requested) => placement.resolveDirectory(requested)))
    .toEqual(["/workspace", "/workspace", "/workspace", "/worktrees/child"])
  expect(placement.resolveDirectory(undefined, "child")).toBe("/worktrees/child")
  expect(() => placement.resolveDirectory("/elsewhere"))
    .toThrow(expect.objectContaining({ code: "workspace_target_pinned", status: 400, retryable: false, message: "workspace-runtime is pinned to /workspace" }))
})
