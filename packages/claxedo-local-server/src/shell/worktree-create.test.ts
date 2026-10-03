import { afterAll, beforeEach, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-base-"))
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root
const [{ ShellRoutes }, store, { controlBus }] = await Promise.all([
  import("./routes"),
  import("@claxedo/server-core/workspace/store/index"),
  import("@claxedo/server-core/platform/runtime/lib/bus"),
])
const app = ShellRoutes()
let directory: string

function git(at: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: at, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

beforeEach(async () => {
  process.env.CLAXEDO_DATA_DIR = await fs.mkdtemp(path.join(root, "case-"))
  directory = path.join(process.env.CLAXEDO_DATA_DIR, "repo")
  await fs.mkdir(directory)
  git(directory, "init", "-b", "main")
  await fs.writeFile(path.join(directory, "file.txt"), "main\n")
  git(directory, "add", ".")
  git(directory, "commit", "-m", "main")
  git(directory, "switch", "-c", "dev")
  await fs.writeFile(path.join(directory, "file.txt"), "dev\n")
  git(directory, "commit", "-am", "dev")
  git(directory, "switch", "main")
  await store.ensureWorkspace({ workspaceId: "root", project_id: "project", directory })
})

afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  await fs.rm(root, { recursive: true, force: true })
})

function request(body: unknown) {
  return app.request("/experimental/worktree?workspaceId=root", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
}

async function create(body: unknown) {
  const ready = Promise.withResolvers<void>()
  const stop = controlBus.subscribe((event) => {
    if (event.type === "worktree.ready") ready.resolve()
    if (event.type === "worktree.failed") ready.reject(new Error(event.message))
  })
  try {
    const response = await request(body)
    expect(response.status).toBe(200)
    await ready.promise
    return await response.json() as { branch: string; directory: string }
  } finally {
    stop()
  }
}

test("creates from the selected branch's committed tip without changing a dirty source", async () => {
  await fs.writeFile(path.join(directory, "file.txt"), "staged source\n")
  git(directory, "add", "file.txt")
  await fs.writeFile(path.join(directory, "file.txt"), "unstaged source\n")
  await fs.writeFile(path.join(directory, "untracked.txt"), "keep\n")
  const before = git(directory, "status", "--porcelain")
  const created = await create({ name: "from-dev", baseRef: "dev" })
  expect(git(created.directory, "rev-parse", "HEAD")).toBe(git(directory, "rev-parse", "dev"))
  expect(git(created.directory, "branch", "--show-current")).toBe(created.branch)
  expect(await fs.readFile(path.join(created.directory, "file.txt"), "utf8")).toBe("dev\n")
  expect(git(created.directory, "status", "--porcelain")).toBe("")
  expect(git(directory, "branch", "--show-current")).toBe("main")
  expect(git(directory, "status", "--porcelain")).toBe(before)
  expect(await fs.readFile(path.join(directory, "file.txt"), "utf8")).toBe("unstaged source\n")
  expect(git(directory, "show", ":file.txt")).toBe("staged source")
  expect(await fs.readFile(path.join(directory, "untracked.txt"), "utf8")).toBe("keep\n")
})

test("an omitted base uses the current commit for callers that request a worktree without a branch", async () => {
  const created = await create({ name: "current" })
  expect(git(created.directory, "rev-parse", "HEAD")).toBe(git(directory, "rev-parse", "HEAD"))
})

test("a tag sharing the current branch's name changes neither an omitted base nor a listed branch choice", async () => {
  git(directory, "tag", "dev", "main")
  git(directory, "switch", "dev")
  const listed = git(directory, "for-each-ref", "--format=%(refname:short)", "refs/heads/dev")
  expect(listed).toBe("heads/dev")
  const omitted = await create({ name: "omitted" })
  expect(git(omitted.directory, "rev-parse", "HEAD")).toBe(git(directory, "rev-parse", "refs/heads/dev"))
  const chosen = await create({ name: "chosen", baseRef: listed })
  expect(git(chosen.directory, "rev-parse", "HEAD")).toBe(git(directory, "rev-parse", "refs/heads/dev"))
  expect(git(directory, "rev-parse", "refs/tags/dev")).not.toBe(git(directory, "rev-parse", "refs/heads/dev"))
})

test("the create response exposes a populated worktree before a session can start there", async () => {
  const response = await request({ name: "ready", baseRef: "dev" })
  expect(response.status).toBe(200)
  const created = await response.json() as { directory: string }
  expect(readFileSync(path.join(created.directory, "file.txt"), "utf8")).toBe("dev\n")
})

test("uses the latest committed tip even when the selected branch is dirty and checked out elsewhere", async () => {
  const other = path.join(process.env.CLAXEDO_DATA_DIR!, "other-session")
  git(directory, "worktree", "add", other, "dev")
  await fs.writeFile(path.join(other, "file.txt"), "new dev commit\n")
  git(other, "commit", "-am", "another session committed")
  await fs.writeFile(path.join(other, "file.txt"), "still working\n")
  const created = await create({ name: "latest-dev", baseRef: "dev" })
  expect(git(created.directory, "rev-parse", "HEAD")).toBe(git(other, "rev-parse", "HEAD"))
  expect(await fs.readFile(path.join(created.directory, "file.txt"), "utf8")).toBe("new dev commit\n")
  expect(await fs.readFile(path.join(other, "file.txt"), "utf8")).toBe("still working\n")
})

test.each(["missing", "--orphan", "", "   ", 42, null])("rejects invalid base %j without creating a worktree and permits a corrected request", async (baseRef) => {
  const before = git(directory, "worktree", "list", "--porcelain")
  const workspaces = await store.listWorkspaces()
  const response = await request({ name: "retry", baseRef })
  expect(response.status).toBe(400)
  expect(git(directory, "worktree", "list", "--porcelain")).toBe(before)
  expect(await store.listWorkspaces()).toEqual(workspaces)
  const created = await create({ name: "retry", baseRef: "dev" })
  expect(created.branch).toBe("claxedo/retry")
  expect(git(created.directory, "rev-parse", "HEAD")).toBe(git(directory, "rev-parse", "dev"))
})
