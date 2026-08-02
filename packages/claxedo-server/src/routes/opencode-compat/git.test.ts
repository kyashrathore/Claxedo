/**
 * Functional coverage for the git/worktree surface backed by
 * `routes/opencode-compat-git.ts`.
 *
 * Before this file the module was referenced only by the static import-graph
 * check in architecture.test.ts — nothing exercised `trees`/`locate`/`gitRun`,
 * and nothing exercised the HTTP handlers in
 * `routes/opencode-compat-worktree-routes.ts` that drive them. Those handlers
 * take a caller-supplied `directory` and hand it to `fs.rm(..., {recursive:
 * true, force: true})` and to `git -C <dir> reset --hard` / `git clean -ffdx`,
 * so "which directories may a request name" is the security property of the
 * whole surface, not a detail.
 *
 * The scoping assertions here are tripwired: neutering `contains()` in
 * opencode-compat-git.ts (or dropping the guard from
 * opencode-compat-worktree-routes.ts) makes the traversal cases fail with the
 * victim tree destroyed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { execFileSync } from "child_process"
import { mkdirSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

// Point the data dir at a temp root BEFORE importing the route modules: they
// pull in workspace-store, which boots (and persists) against CLAXEDO_DATA_DIR
// on first use. Same idiom as worktree-events.test.ts.
const root = path.join(realpathSync(os.tmpdir()), `compat-git-${randomUUID().slice(0, 8)}`)
const prev = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}
mkdirSync(root, { recursive: true })
process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const { Hono } = await import("hono")
const { contains, gitRun, locate, trees } = await import("./git")
const { OpenCodeCompatRoutes } = await import("./index")
const { ensureWorkspace } = await import("../../workspace/store")
const { dataDir } = await import("../../lib/paths")
const { unsignedLocalRequestGuard } = await import("../../control-plane/deployment-mode")

const app = new Hono()
app.route("/", OpenCodeCompatRoutes())

function git(dir: string, args: string[]) {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" })
}

async function makeRepo(name: string) {
  const dir = path.join(root, "repos", name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "README.md"), `# ${name}\n`)
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" })
  git(dir, ["config", "user.email", "test@example.com"])
  git(dir, ["config", "user.name", "test"])
  git(dir, ["add", "README.md"])
  git(dir, ["commit", "-m", "init"])
  return dir
}

function exists(target: string) {
  return fs.access(target).then(() => true, () => false)
}

// The project workspace the request is authorized for, and an unrelated tree
// that lives NEXT TO it — the thing a `../` in the request must never reach.
let project = ""
let victim = ""

beforeAll(async () => {
  project = await makeRepo("project-a")
  await ensureWorkspace({ workspaceId: "ws_a", project_id: "proj_a", directory: project })
})

// Rebuilt per test on purpose: when the guard is missing, the first traversal
// case really does `rm -rf` this tree, and a shared fixture would turn one
// failure into a cascade of unrelated ones.
beforeEach(async () => {
  await fs.rm(path.join(root, "repos", "victim"), { recursive: true, force: true })
  victim = await makeRepo("victim")
  await fs.writeFile(path.join(victim, "PRECIOUS.txt"), "uncommitted work\n")
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
  process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
})

describe("opencode-compat-git primitives", () => {
  test("trees() parses `git worktree list --porcelain` into path/branch rows", () => {
    const rows = trees(
      [
        "worktree /repos/project-a",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "",
        "worktree /repos/project-a-wt",
        "HEAD 2222222222222222222222222222222222222222",
        "branch refs/heads/opencode/feature",
        "",
      ].join("\n"),
    )
    expect(rows).toEqual([
      { path: "/repos/project-a", branch: "refs/heads/main" },
      { path: "/repos/project-a-wt", branch: "refs/heads/opencode/feature" },
    ])
  })

  test("locate() canonicalizes traversal-equivalent paths before matching", async () => {
    const list = await gitRun(project, ["worktree", "list", "--porcelain"])
    expect(list.ok).toBe(true)
    const rows = trees(list.out)
    // `<project>/subdir/..` is the same directory as `<project>`; locate must
    // see through the traversal rather than string-comparing.
    const noisy = path.join(project, "docs", "..")
    expect((await locate(rows, noisy))?.branch).toBe("refs/heads/main")
    // An unrelated tree must NOT match a registered worktree row.
    expect(await locate(rows, victim)).toBeUndefined()
  })

  test("contains() rejects traversal and sibling-prefix escapes", () => {
    expect(contains("/srv/project", "/srv/project")).toBe(true)
    expect(contains("/srv/project", "/srv/project/wt-1")).toBe(true)
    expect(contains("/srv/project", "/srv/project/../victim")).toBe(false)
    expect(contains("/srv/project", "/srv/victim")).toBe(false)
    // `/srv/project-evil` shares a string prefix with `/srv/project` but is a
    // sibling, not a child. A naive `startsWith` would let it through.
    expect(contains("/srv/project", "/srv/project-evil")).toBe(false)
    expect(contains("/srv/project", "/etc")).toBe(false)
  })
})

describe("DELETE /experimental/worktree keeps deletions inside the workspace", () => {
  test("refuses a `../` traversal out of the project and leaves the sibling tree intact", async () => {
    const escape = path.join(project, "..", "victim")
    const res = await app.request(
      `/experimental/worktree?workspaceId=ws_a&directory=${encodeURIComponent(escape)}`,
      { method: "DELETE" },
    )
    // Asserted BEFORE the status code on purpose: the handler ends in
    // `fs.rm(target, {recursive: true, force: true})`, so a missed guard is an
    // unrecoverable delete of a tree the request was never scoped to. When this
    // guard is absent the failure reads "expected false to be true" on the
    // victim tree itself, which is the finding, rather than a status mismatch.
    expect(await exists(victim)).toBe(true)
    expect(await exists(path.join(victim, "PRECIOUS.txt"))).toBe(true)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: { code: "opencode_worktree_outside_workspace" },
    })
  })

  test("refuses an absolute directory outside the project", async () => {
    const res = await app.request(
      `/experimental/worktree?workspaceId=ws_a&directory=${encodeURIComponent(victim)}`,
      { method: "DELETE" },
    )
    expect(await exists(path.join(victim, "PRECIOUS.txt"))).toBe(true)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: { code: "opencode_worktree_outside_workspace" },
    })
  })

  test("refuses an out-of-project directory smuggled through the JSON body", async () => {
    // `requestedTarget` falls back to the body when no `directory` query param
    // is present, so the body is a second, equally privileged way to name the
    // target — and the one that bypasses `resolveWorkspace` entirely, since the
    // workspace is resolved from `?workspaceId=` instead.
    const res = await app.request("/experimental/worktree?workspaceId=ws_a", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: victim }),
    })
    expect(await exists(path.join(victim, "PRECIOUS.txt"))).toBe(true)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: { code: "opencode_worktree_outside_workspace" },
    })
  })

  test("still deletes a real worktree inside the project", async () => {
    // Guard against a fix that just rejects everything: the legitimate path
    // must keep working.
    const created = await app.request(
      `/experimental/worktree?directory=${encodeURIComponent(project)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "inside-wt" }),
      },
    )
    expect(created.status).toBe(200)
    const info = await created.json() as { directory: string }
    expect(await exists(info.directory)).toBe(true)
    // Worktrees are created BESIDE the repository, under
    // `<dataDir>/worktree/<project_id>` (nextWorktreeInfo) — not inside it. The
    // containment guard has to allow that root too, or every legitimate delete
    // would be refused.
    expect(contains(path.join(dataDir(), "worktree", "proj_a"), info.directory)).toBe(true)
    expect(contains(project, info.directory)).toBe(false)

    const res = await app.request(
      `/experimental/worktree?workspaceId=ws_a&directory=${encodeURIComponent(info.directory)}`,
      { method: "DELETE" },
    )
    expect(res.status).toBe(200)
    expect(await exists(info.directory)).toBe(false)
  })
})

describe("POST /experimental/worktree/reset keeps `git reset --hard`/`clean -ffdx` inside the workspace", () => {
  test("refuses an out-of-project target and leaves its uncommitted work intact", async () => {
    const res = await app.request(
      `/experimental/worktree/reset?workspaceId=ws_a&directory=${encodeURIComponent(victim)}`,
      { method: "POST" },
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: { code: "opencode_worktree_outside_workspace" },
    })
    // `resetWorktree` runs `git -C <target> reset --hard` then `clean -ffdx`,
    // which deletes untracked files. PRECIOUS.txt is untracked on purpose.
    expect(await exists(path.join(victim, "PRECIOUS.txt"))).toBe(true)
  })

  test("refuses a `../` traversal target", async () => {
    const escape = path.join(project, "..", "victim")
    const res = await app.request(
      `/experimental/worktree/reset?workspaceId=ws_a&directory=${encodeURIComponent(escape)}`,
      { method: "POST" },
    )
    expect(res.status).toBe(400)
    expect(await exists(path.join(victim, "PRECIOUS.txt"))).toBe(true)
  })
})

describe("the worktree surface is unreachable from off-box in unsigned self-host mode", () => {
  // OpenCodeCompatRoutes carries no per-route bearer gate; the global
  // `unsignedLocalRequestGuard` is the whole gate for `/experimental/*`. Assert
  // it actually covers the destructive verbs.
  function guarded() {
    const inner = new Hono()
    inner.use(
      unsignedLocalRequestGuard({
        mode: "local",
        authConfig: { enabled: false, mode: "local-only", reason: "signed/cloud auth is disabled" },
      }),
    )
    inner.route("/", OpenCodeCompatRoutes())
    return inner
  }

  const SURFACES: Array<[string, string]> = [
    ["DELETE", "/experimental/worktree"],
    ["POST", "/experimental/worktree"],
    ["POST", "/experimental/worktree/reset"],
  ]

  test.each(SURFACES)("%s %s from a non-loopback origin is refused", async (method, route) => {
    const res = await guarded().request(
      `http://remote.example${route}?workspaceId=ws_a&directory=${encodeURIComponent(victim)}`,
      { method },
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: { code: "unsigned_local_loopback_required" },
    })
    expect(await exists(path.join(victim, "PRECIOUS.txt"))).toBe(true)
  })
})
