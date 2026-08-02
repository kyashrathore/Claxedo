import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RuntimeStore } from "./store"
import { assertTarget, withWorkspaceTarget } from "./target"
import { WorkspaceWorktreeManager } from "./worktree"

const roots: string[] = []

async function git(args: string[], cwd: string) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(stderr)
  return stdout.trim()
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-worktree-"))
  roots.push(root)
  const source = path.join(root, "source")
  await fs.mkdir(source)
  await git(["init", "-b", "main"], source)
  await git(["config", "user.email", "runtime@example.test"], source)
  await git(["config", "user.name", "Workspace Runtime"], source)
  await fs.writeFile(path.join(source, "README.md"), "base\n")
  await git(["add", "README.md"], source)
  await git(["commit", "-m", "base"], source)
  const store = new RuntimeStore(path.join(root, "state"))
  const manager = new WorkspaceWorktreeManager({
    workspaceId: "workspace-1",
    sourceDirectory: source,
    root: path.join(root, "hidden"),
    store,
  })
  return { source, store, manager }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("WorkspaceWorktreeManager", () => {
  test("serializes concurrent creation and isolates branches", async () => {
    const { manager, store } = await fixture()
    const [first, second] = await Promise.all([
      manager.ensure({ sessionId: "session-a" }),
      manager.ensure({ sessionId: "session-b" }),
    ])

    expect(first.branch).toBe("claxedo/session/session-a")
    expect(second.branch).toBe("claxedo/session/session-b")
    expect(first.baseCommit).toBe(second.baseCommit)
    await fs.writeFile(path.join(first.path, "only-a.txt"), "a\n")
    expect(await fs.stat(path.join(second.path, "only-a.txt")).then(() => true, () => false)).toBe(false)
    expect(store.listWorktrees("workspace-1").map((item) => item.sessionId).sort()).toEqual([
      "session-a",
      "session-b",
    ])
    manager.close()
    store.close()
  })

  test("reuses an idempotent retry and repairs a missing checkout", async () => {
    const { manager, store } = await fixture()
    const first = await manager.ensure({ sessionId: "session-retry" })
    expect(await manager.ensure({ sessionId: "session-retry" })).toMatchObject({
      path: first.path,
      branch: first.branch,
      baseCommit: first.baseCommit,
      state: "active",
    })

    await fs.rm(first.path, { recursive: true, force: true })
    const repaired = await manager.ensure({ sessionId: "session-retry" })
    expect(repaired.path).toBe(first.path)
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], repaired.path)).toBe(first.branch)
    manager.close()
    store.close()
  })

  test("rejects traversal and authorizes only registered paths", async () => {
    const { source, manager, store } = await fixture()
    await expect(manager.ensure({ sessionId: "../escape" })).rejects.toThrow("session id is not path-safe")
    const worktree = await manager.ensure({ sessionId: "session-safe" })
    withWorkspaceTarget({ workspaceId: "workspace-1", directory: source }, () => {
      expect(assertTarget(worktree.path)).toBe(worktree.path)
      expect(() => assertTarget(path.dirname(worktree.path))).toThrow("pinned")
    })
    manager.close()
    store.close()
  })
})
