import { describe, expect, test } from "bun:test"
import { queryClient } from "../shared/query/query-client"
import { Worktree, type WorktreeState, validProjectRef, validWorktree } from "./worktree"

const dir = (name: string) => `/tmp/opencode-worktree-${name}-${crypto.randomUUID()}`

describe("Worktree", () => {
  test("normalizes trailing slashes into one query state", () => {
    const key = dir("normalize")
    Worktree.ready(`${key}/`)

    expect(Worktree.get(key)).toEqual({ status: "ready" })
    expect(queryClient.getQueryData<WorktreeState>(["shell", "worktree", key, "state"])).toEqual({ status: "ready" })
  })

  test("pending does not overwrite terminal state", () => {
    const key = dir("terminal")
    Worktree.failed(key, "boom")
    Worktree.pending(key)

    expect(Worktree.get(key)).toEqual({ status: "failed", message: "boom" })
  })

  test("wait resolves shared pending waiter when ready", async () => {
    const key = dir("wait-ready")
    Worktree.pending(key)

    const a = Worktree.wait(key)
    const b = Worktree.wait(`${key}/`)

    expect(a).toBe(b)

    Worktree.ready(key)

    expect(await a).toEqual({ status: "ready" })
    expect(await b).toEqual({ status: "ready" })
  })

  test("wait resolves with failure message", async () => {
    const key = dir("wait-failed")
    const waiting = Worktree.wait(key)

    Worktree.failed(key, "permission denied")

    expect(await waiting).toEqual({ status: "failed", message: "permission denied" })
    expect(await Worktree.wait(key)).toEqual({ status: "failed", message: "permission denied" })
  })
})

describe("validWorktree", () => {
  test("keeps workspace relay references out of local filesystem paths", () => {
    expect(validWorktree("workspace:ws_1")).toBe(false)
  })

  test("rejects exact dot path segments without rejecting ordinary names", () => {
    expect(validWorktree("/Users/yash/project/.")).toBe(false)
    expect(validWorktree("/Users/yash/project/../other")).toBe(false)
    expect(validWorktree("/Users/yash/project.../other")).toBe(true)
    expect(validWorktree("/Users/yash/project..name/other")).toBe(true)
  })
})

describe("validProjectRef", () => {
  test("accepts local worktrees and workspace ids through the bounded resolver", () => {
    expect(validProjectRef("/Users/yash/project")).toBe(true)
    expect(validProjectRef("ws_1")).toBe(true)
    expect(validProjectRef("workspace:ws_1")).toBe(true)
  })

  test("rejects invalid workspace pseudo-directory reference shapes", () => {
    expect(validProjectRef("workspace:../ws_1")).toBe(false)
    expect(validProjectRef("workspace:ws/1")).toBe(false)
    expect(validProjectRef("workspace:")).toBe(false)
  })
})

describe("source ownership", () => {
  test("keeps worktree state in the query client instead of private maps", async () => {
    const source = await Bun.file(new URL("./worktree.ts", import.meta.url)).text()

    expect(source).not.toContain("const state = new Map")
    expect(source).not.toContain("const waiters = new Map")
  })
})
