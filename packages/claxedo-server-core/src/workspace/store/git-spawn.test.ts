import { afterAll, describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * `ensureWorkspace` is reached by `resolveWorkspace({ create: true })` on every
 * request that carries `?directory=`, and each call used to read git identity
 * through four sequential `git` subprocesses before it looked the workspace up.
 * These cases pin the spawn count itself, because the observable result is
 * identical either way — only the subprocess cost differs.
 *
 * The counter is a real `git` shim placed first on PATH, so it counts the
 * spawns the store actually performs rather than a mocked module boundary.
 */

const canonicalDirectory = (directory: string) => path.resolve(realpathSync.native?.(directory) ?? realpathSync(directory))
const root = path.join(canonicalDirectory(os.tmpdir()), `workspace-store-git-spawn-${randomUUID().slice(0, 8)}`)
const previousDataDir = process.env.CLAXEDO_DATA_DIR
const previousGitTrace = process.env.GIT_TRACE2_EVENT
process.env.CLAXEDO_DATA_DIR = root

/** Resolved before the shim goes on PATH, so the shim can exec the real git. */
const realGit = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["git"], { encoding: "utf-8" })
  .trim()
  .split(/\r?\n/, 1)[0]!
const spawnLog = path.join(root, "git-spawns.log")
process.env.GIT_TRACE2_EVENT = spawnLog

const store = await import("@claxedo/server-core/workspace/store/index")

async function spawnCount() {
  const raw = await fs.readFile(spawnLog, "utf-8").catch(() => "")
  return raw.split("\n").filter((line) => {
    try {
      return (JSON.parse(line) as { event?: unknown }).event === "version"
    } catch {
      return false
    }
  }).length
}

/** Runs the body and reports how many `git` processes it spawned. */
async function countingGitSpawns<T>(body: () => Promise<T>) {
  const before = await spawnCount()
  const value = await body()
  return { value, spawns: (await spawnCount()) - before }
}

async function gitRepo(name: string) {
  const dir = path.join(root, "repos", name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "README.md"), `# ${name}\n`)
  const run = (args: string[]) => execFileSync(realGit, ["-C", dir, ...args], { stdio: "ignore" })
  execFileSync(realGit, ["init", "-b", "main", dir], { stdio: "ignore" })
  run(["config", "user.email", "test@example.com"])
  run(["config", "user.name", "test"])
  run(["remote", "add", "origin", `https://github.com/foo/${name}.git`])
  run(["add", "README.md"])
  run(["commit", "-m", "init"])
  return dir
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a workspace")
  return value
}

describe("workspace store git subprocess cost", () => {
  afterAll(async () => {
    if (previousGitTrace === undefined) delete process.env.GIT_TRACE2_EVENT
    else process.env.GIT_TRACE2_EVENT = previousGitTrace
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
    await fs.rm(root, { recursive: true, force: true })
  })

  test("a directory the store has never seen reads git identity", async () => {
    const dir = await gitRepo("first-sight")
    const created = await countingGitSpawns(() => store.ensureWorkspace({ directory: dir }))
    const ws = defined(created.value)

    expect(ws.repo_key).toBeTruthy()
    expect(ws.git_branch).toBe("main")
    expect(ws.git_remote).toBe("https://github.com/foo/first-sight.git")
    expect(ws.repo_name).toBe("first-sight")
    // rev-parse --show-toplevel, rev-parse --git-common-dir,
    // rev-parse --abbrev-ref HEAD, remote get-url origin
    expect(created.spawns).toBe(4)
  })

  test("an already-known workspace re-ensures without spawning git", async () => {
    const dir = await gitRepo("already-known")
    const first = defined(await store.ensureWorkspace({ directory: dir }))

    const again = await countingGitSpawns(() => store.ensureWorkspace({ directory: dir }))
    const second = defined(again.value)

    expect(again.spawns).toBe(0)
    expect(second.id).toBe(first.id)
    expect(second.directory).toBe(first.directory)
    expect(second.project_id).toBe(first.project_id)
    expect(second.repo_key).toBe(first.repo_key)
    expect(second.repo_root).toBe(first.repo_root)
    expect(second.repo_name).toBe(first.repo_name)
    expect(second.git_branch).toBe(first.git_branch)
    expect(second.git_remote).toBe(first.git_remote)
    expect(second.updated_at).toBeGreaterThanOrEqual(first.updated_at)
  })

  test("concurrent first-touch ensures create one canonical workspace", async () => {
    const dir = await gitRepo("concurrent-first-touch")

    const ensured = await countingGitSpawns(() => Promise.all([
      store.ensureWorkspace({ directory: dir }),
      store.ensureWorkspace({ directory: dir }),
      store.ensureWorkspace({ directory: dir }),
    ]))
    const workspaces = ensured.value.map(defined)
    const stored = (await store.listWorkspaces()).filter((item) => item.directory === canonicalDirectory(dir))

    expect(new Set(workspaces.map((item) => item.id))).toHaveLength(1)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.id).toBe(workspaces[0]?.id)
    expect(ensured.spawns).toBe(4)
  })

  test("resolveWorkspace(create=true) on a known directory spawns no git", async () => {
    const dir = await gitRepo("boot-request")
    const first = defined(await store.resolveWorkspace({ directory: dir, create: true }))

    const again = await countingGitSpawns(() => store.resolveWorkspace({ directory: dir, create: true }))

    expect(again.spawns).toBe(0)
    expect(defined(again.value).id).toBe(first.id)
  })

  test("concurrent create resolves one canonical workspace for a directory", async () => {
    const dir = await gitRepo("concurrent-create")

    const results = await Promise.all([
      store.resolveWorkspace({ directory: dir, create: true }),
      store.resolveWorkspace({ directory: dir, create: true }),
    ])

    expect(new Set(results.map((workspace) => defined(workspace).id))).toHaveLength(1)
    expect((await store.listWorkspaces()).filter((workspace) => workspace.directory === canonicalDirectory(dir))).toHaveLength(1)
  })

  test("rebinding a known id to a different directory still reads git identity", async () => {
    const before = await gitRepo("rebind-before")
    const after = await gitRepo("rebind-after")
    const first = defined(await store.ensureWorkspace({ workspaceId: "ws_rebind", directory: before }))

    const moved = await countingGitSpawns(() =>
      store.ensureWorkspace({ workspaceId: "ws_rebind", directory: after }),
    )
    const ws = defined(moved.value)

    expect(moved.spawns).toBe(4)
    expect(ws.id).toBe("ws_rebind")
    expect(ws.directory).toBe(canonicalDirectory(after))
    expect(ws.repo_key).not.toBe(first.repo_key)
    expect(ws.repo_name).toBe("rebind-after")
    expect(ws.git_remote).toBe("https://github.com/foo/rebind-after.git")
  })

  test("a cloud workspace never reads local git", async () => {
    const created = await countingGitSpawns(() =>
      store.ensureWorkspace({
        workspaceId: "ws_cloud_spawn",
        directory: "/workspace",
        kind: "cloud",
        driver: "daytona",
        repo_url: "https://github.com/foo/cloud-repo.git",
      }),
    )
    const ws = defined(created.value)

    expect(created.spawns).toBe(0)
    expect(ws.repo_name).toBe("cloud-repo")
    expect(ws.git_remote).toBe("https://github.com/foo/cloud-repo.git")

    const again = await countingGitSpawns(() =>
      store.ensureWorkspace({
        workspaceId: "ws_cloud_spawn",
        directory: "/workspace",
        kind: "cloud",
        driver: "daytona",
        repo_url: "https://github.com/foo/cloud-repo.git",
      }),
    )
    expect(again.spawns).toBe(0)
    expect(defined(again.value).repo_name).toBe("cloud-repo")
  })
})
