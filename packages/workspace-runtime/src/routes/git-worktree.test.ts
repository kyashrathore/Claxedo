import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { execFile } from "node:child_process"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { createWorkspaceRuntimeClient, WorkspaceRuntimeClientError } from "../client"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import type { GitCommitSummary, GitWorktreeStatus } from "../workspace-files/git-worktree"
import { registerWorkspaceDirectory, unregisterWorkspaceDirectory, workspaceId } from "../target"
import { GitWorktreeRoutes } from "./git-worktree"

const execFileAsync = promisify(execFile)

async function git(directory: string, args: string[]) {
  const result = await execFileAsync("git", args, { cwd: directory })
  return result.stdout.trim()
}

async function configureIdentity(directory: string) {
  await git(directory, ["config", "user.email", "test@example.com"])
  await git(directory, ["config", "user.name", "Test User"])
}

async function withWorkspace(fn: (directory: string) => Promise<void>, input: { commit?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "workspace-runtime-git-worktree-"))
  const previous = process.env.WORKSPACE_RUNTIME_DIRECTORY
  try {
    process.env.WORKSPACE_RUNTIME_DIRECTORY = directory
    await git(directory, ["init", "-b", "main"])
    await configureIdentity(directory)
    if (input.commit !== false) {
      await writeFile(path.join(directory, "doc.md"), "before\n")
      await writeFile(path.join(directory, "mod.md"), "one\ntwo\n")
      await writeFile(path.join(directory, "del.md"), "gone\nsoon\ntoo\n")
      await writeFile(path.join(directory, "old.md"), "same\n")
      await git(directory, ["add", "."])
      await git(directory, ["commit", "-m", "initial"])
    }
    await fn(directory)
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_RUNTIME_DIRECTORY
    else process.env.WORKSPACE_RUNTIME_DIRECTORY = previous
    await rm(directory, { recursive: true, force: true })
  }
}

async function withBareRemote(directory: string, fn: (remote: string) => Promise<void>) {
  const remote = await mkdtemp(path.join(tmpdir(), "workspace-runtime-git-remote-"))
  try {
    await git(remote, ["init", "--bare", "-b", "main"])
    await git(directory, ["remote", "add", "origin", remote])
    await fn(remote)
  } finally {
    await rm(remote, { recursive: true, force: true })
  }
}

function app() {
  return new Hono().route("/api/wr/git", GitWorktreeRoutes())
}

function viewerApp() {
  const server = new Hono<{ Variables: RelayHostAuthContext }>()
  server.use("*", async (c, next) => {
    const now = Math.floor(Date.now() / 1000)
    c.set("relayHostAuth", {
      iss: "workspace-relay",
      aud: "workspace-host-service",
      principal_kind: "user",
      actor_id: "user_1",
      actor_kind: "human",
      org_id: "org_1",
      workspace_id: "ws_1",
      host_id: "host_1",
      role: "viewer",
      backing: "cloud-vm",
      exp: now + 60,
      iat: now,
      jti: "jti_1",
      parent_jti: "rat_jti_1",
    })
    return await next()
  })
  return server.route("/api/wr/git", GitWorktreeRoutes())
}

type Server = { request(input: string, init?: RequestInit): Response | Promise<Response> }

function post(server: Server, route: string, body: unknown) {
  return server.request(`http://localhost/api/wr/git/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function status(server: Server = app()) {
  const response = await server.request("http://localhost/api/wr/git/status")
  expect(response.status).toBe(200)
  return await response.json() as GitWorktreeStatus
}

async function log(query = "") {
  const response = await app().request(`http://localhost/api/wr/git/log${query}`)
  expect(response.status).toBe(200)
  return (await response.json() as { commits: GitCommitSummary[] }).commits
}

describe("GitWorktreeRoutes status", () => {
  test("splits staged and unstaged entries with letters, counts and rename sources", async () => {
    await withWorkspace(async (directory) => {
      await writeFile(path.join(directory, "added.md"), "a\nb\nc\n")
      await git(directory, ["add", "added.md"])
      await writeFile(path.join(directory, "doc.md"), "after\nmore\n")
      await git(directory, ["add", "doc.md"])
      await git(directory, ["mv", "old.md", "renamed.md"])
      await writeFile(path.join(directory, "mod.md"), "one\nchanged\n")
      await writeFile(path.join(directory, "new.md"), "x\ny\n")
      await unlink(path.join(directory, "del.md"))

      const body = await status()
      expect(body.branch).toBe("main")
      expect(body.upstream).toBeUndefined()
      expect(body).toMatchObject({ ahead: 0, behind: 0 })
      expect(body.staged.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
        { path: "added.md", status: "added", additions: 3, deletions: 0 },
        { path: "doc.md", status: "modified", additions: 2, deletions: 1 },
        { path: "renamed.md", status: "renamed", additions: 0, deletions: 0, from: "old.md" },
      ])
      expect(body.unstaged.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
        { path: "del.md", status: "deleted", additions: 0, deletions: 3 },
        { path: "mod.md", status: "modified", additions: 1, deletions: 1 },
        { path: "new.md", status: "untracked", additions: 3, deletions: 0 },
      ])
    })
  })

  test("reports a staged deletion once and a binary change with zero counts", async () => {
    await withWorkspace(async (directory) => {
      await git(directory, ["rm", "-q", "del.md"])
      await writeFile(path.join(directory, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]))
      await git(directory, ["add", "blob.bin"])

      const body = await status()
      expect(body.staged.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
        { path: "blob.bin", status: "added", additions: 0, deletions: 0 },
        { path: "del.md", status: "deleted", additions: 0, deletions: 3 },
      ])
      expect(body.unstaged).toEqual([])
    })
  })

  test("reports branch, upstream, ahead and behind against a bare remote", async () => {
    await withWorkspace(async (directory) => {
      await withBareRemote(directory, async (remote) => {
        await git(directory, ["push", "-q", "-u", "origin", "main"])
        const other = await mkdtemp(path.join(tmpdir(), "workspace-runtime-git-other-"))
        try {
          await git(other, ["clone", "-q", remote, "."])
          await configureIdentity(other)
          await writeFile(path.join(other, "theirs.md"), "theirs\n")
          await git(other, ["add", "theirs.md"])
          await git(other, ["commit", "-q", "-m", "theirs"])
          await git(other, ["push", "-q", "origin", "main"])
        } finally {
          await rm(other, { recursive: true, force: true })
        }
        await writeFile(path.join(directory, "ours.md"), "ours\n")
        await git(directory, ["add", "ours.md"])
        await git(directory, ["commit", "-q", "-m", "ours"])
        await git(directory, ["fetch", "-q", "origin"])

        expect(await status()).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 1, behind: 1 })
      })
    })
  })

  test("lists unmerged files as conflicted in the unstaged group", async () => {
    await withWorkspace(async (directory) => {
      await git(directory, ["checkout", "-q", "-b", "other"])
      await writeFile(path.join(directory, "doc.md"), "other\n")
      await git(directory, ["commit", "-q", "-am", "other"])
      await git(directory, ["checkout", "-q", "main"])
      await writeFile(path.join(directory, "doc.md"), "main\n")
      await git(directory, ["commit", "-q", "-am", "main"])
      await expect(git(directory, ["merge", "other"])).rejects.toThrow()

      const body = await status()
      expect(body.unstaged.map((entry) => [entry.path, entry.status])).toEqual([["doc.md", "conflicted"]])
      expect(body.staged).toEqual([])

      const commit = await post(app(), "commit-staged", { message: "resolve" })
      expect(commit.status).toBe(409)
      await expect(commit.json()).resolves.toMatchObject({ error: { code: "git_conflict" } })
    })
  })
})

describe("GitWorktreeRoutes stage and unstage", () => {
  test("stage moves a modified file across groups and stages a deletion", async () => {
    await withWorkspace(async (directory) => {
      await writeFile(path.join(directory, "mod.md"), "one\nchanged\n")
      await unlink(path.join(directory, "del.md"))
      expect((await status()).staged).toEqual([])

      const staged = await post(app(), "stage", { paths: ["mod.md", "del.md"] })
      expect(staged.status).toBe(204)

      const body = await status()
      expect(body.staged.map((entry) => [entry.path, entry.status])).toEqual([["del.md", "deleted"], ["mod.md", "modified"]])
      expect(body.unstaged).toEqual([])
    })
  })

  test("unstage moves a file back to the unstaged group", async () => {
    await withWorkspace(async (directory) => {
      await writeFile(path.join(directory, "mod.md"), "one\nchanged\n")
      await git(directory, ["add", "mod.md"])
      expect((await status()).staged.map((entry) => entry.path)).toEqual(["mod.md"])

      const unstaged = await post(app(), "unstage", { paths: ["mod.md"] })
      expect(unstaged.status).toBe(204)

      const body = await status()
      expect(body.staged).toEqual([])
      expect(body.unstaged.map((entry) => [entry.path, entry.status])).toEqual([["mod.md", "modified"]])
    })
  })

  test("unstage works on a repository without a first commit", async () => {
    await withWorkspace(async (directory) => {
      await writeFile(path.join(directory, "first.md"), "first\n")
      await git(directory, ["add", "first.md"])
      expect((await status()).staged.map((entry) => [entry.path, entry.status])).toEqual([["first.md", "added"]])

      expect((await post(app(), "unstage", { paths: ["first.md"] })).status).toBe(204)

      const body = await status()
      expect(body.staged).toEqual([])
      expect(body.unstaged.map((entry) => [entry.path, entry.status])).toEqual([["first.md", "untracked"]])
    }, { commit: false })
  })

  test("rejects empty path lists and paths outside the workspace", async () => {
    await withWorkspace(async () => {
      const empty = await post(app(), "stage", { paths: [] })
      expect(empty.status).toBe(400)
      await expect(empty.json()).resolves.toMatchObject({ error: { code: "git_paths_required" } })

      const escape = await post(app(), "stage", { paths: ["../outside.md"] })
      expect(escape.status).toBe(400)
      await expect(escape.json()).resolves.toMatchObject({ error: { code: "git_invalid_path" } })
    })
  })

  test("rejects entries that resolve to the workspace root instead of staging everything", async () => {
    await withWorkspace(async (directory) => {
      await writeFile(path.join(directory, "mod.md"), "one\nchanged\n")
      await writeFile(path.join(directory, "new.md"), "new\n")
      await unlink(path.join(directory, "del.md"))
      for (const root of [" ", "\t", ".", "./"]) {
        const response = await post(app(), "stage", { paths: [root] })
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toMatchObject({ error: { code: "git_invalid_path" } })
      }
      const unstage = await post(app(), "unstage", { paths: [" "] })
      expect(unstage.status).toBe(400)
      const body = await status()
      expect(body.staged).toEqual([])
      expect(body.unstaged.map((entry) => entry.path).sort()).toEqual(["del.md", "mod.md", "new.md"])
    })
  })
})

describe("GitWorktreeRoutes commit-staged", () => {
  test("commits the index and advances HEAD", async () => {
    await withWorkspace(async (directory) => {
      const before = await git(directory, ["rev-parse", "HEAD"])
      await writeFile(path.join(directory, "mod.md"), "one\nchanged\n")
      await git(directory, ["add", "mod.md"])

      const response = await post(app(), "commit-staged", { message: "change mod" })
      expect(response.status).toBe(200)
      const body = await response.json() as { commit: string }
      const after = await git(directory, ["rev-parse", "HEAD"])
      expect(body.commit).toBe(after)
      expect(after).not.toBe(before)
      expect(await git(directory, ["log", "-1", "--pretty=%s"])).toBe("change mod")
      expect((await status()).staged).toEqual([])
    })
  })

  test("refuses an empty message and an empty index", async () => {
    await withWorkspace(async (directory) => {
      await writeFile(path.join(directory, "mod.md"), "one\nchanged\n")
      await git(directory, ["add", "mod.md"])
      const empty = await post(app(), "commit-staged", { message: "   \n" })
      expect(empty.status).toBe(400)
      await expect(empty.json()).resolves.toMatchObject({ error: { code: "git_empty_message" } })

      await git(directory, ["reset", "-q", "--", "mod.md"])
      const nothing = await post(app(), "commit-staged", { message: "nothing" })
      expect(nothing.status).toBe(400)
      await expect(nothing.json()).resolves.toMatchObject({ error: { code: "git_nothing_staged" } })
      expect(await git(directory, ["log", "-1", "--pretty=%s"])).toBe("initial")
    })
  })

  test("amend rewrites the tip without adding a commit", async () => {
    await withWorkspace(async (directory) => {
      const before = await git(directory, ["rev-parse", "HEAD"])
      await writeFile(path.join(directory, "mod.md"), "one\nchanged\n")
      await git(directory, ["add", "mod.md"])

      const response = await post(app(), "commit-staged", { message: "initial, amended", amend: true })
      expect(response.status).toBe(200)
      expect(await git(directory, ["rev-parse", "HEAD"])).not.toBe(before)
      expect(await git(directory, ["rev-list", "--count", "HEAD"])).toBe("1")
      expect(await git(directory, ["log", "-1", "--pretty=%s"])).toBe("initial, amended")
    })
  })
})

describe("GitWorktreeRoutes push", () => {
  test("pushes to origin, sets the upstream, and reports a rejected push", async () => {
    await withWorkspace(async (directory) => {
      await withBareRemote(directory, async (remote) => {
        const response = await post(app(), "push", { setUpstream: true })
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({ remote: "origin", branch: "main" })
        expect(await git(directory, ["rev-parse", "--abbrev-ref", "main@{upstream}"])).toBe("origin/main")
        expect(await git(remote, ["rev-parse", "main"])).toBe(await git(directory, ["rev-parse", "HEAD"]))

        await git(directory, ["commit", "-q", "--amend", "-m", "rewritten"])
        const rejected = await post(app(), "push", {})
        expect(rejected.status).toBe(502)
        const body = await rejected.json() as { error: { code: string; message: string } }
        expect(body.error.code).toBe("git_push_rejected")
        expect(body.error.message).toContain("rejected")
      })
    })
  })
})

describe("GitWorktreeRoutes log", () => {
  test("returns author, date, refs and parents newest first", async () => {
    await withWorkspace(async (directory) => {
      const first = await git(directory, ["rev-parse", "HEAD"])
      await writeFile(path.join(directory, "mod.md"), "one\nchanged\n")
      await git(directory, ["commit", "-q", "-am", "second"])
      const second = await git(directory, ["rev-parse", "HEAD"])
      await git(directory, ["tag", "v1"])

      const commits = await log()
      expect(commits).toHaveLength(2)
      expect(commits[0]).toEqual({
        hash: second,
        shortHash: second.slice(0, 7),
        subject: "second",
        author: "Test User",
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/),
        refs: ["main", "tag: v1"],
        parents: [first],
      })
      expect(commits[1]).toMatchObject({ hash: first, subject: "initial", refs: [], parents: [] })

      expect((await log("?limit=1")).map((commit) => commit.hash)).toEqual([second])
    })
  })

  test("returns no commits for a repository without a first commit", async () => {
    await withWorkspace(async () => {
      expect(await log()).toEqual([])
    }, { commit: false })
  })
})

describe("GitWorktreeRoutes viewer role", () => {
  test("denies every write while serving reads", async () => {
    await withWorkspace(async (directory) => {
      await writeFile(path.join(directory, "mod.md"), "one\nchanged\n")
      expect((await status(viewerApp())).unstaged.map((entry) => entry.path)).toEqual(["mod.md"])
      expect((await viewerApp().request("http://localhost/api/wr/git/log")).status).toBe(200)

      const writes: Array<[string, unknown]> = [
        ["stage", { paths: ["mod.md"] }],
        ["unstage", { paths: ["mod.md"] }],
        ["commit-staged", { message: "blocked" }],
        ["push", {}],
      ]
      for (const [route, body] of writes) {
        const response = await post(viewerApp(), route, body)
        expect(response.status).toBe(403)
        await expect(response.json()).resolves.toEqual({
          error: { code: "relay_role_denied", message: "Workspace role does not allow Git writes" },
        })
      }
      expect(await git(directory, ["diff", "--cached", "--name-only"])).toBe("")
      expect(await git(directory, ["log", "-1", "--pretty=%s"])).toBe("initial")
    })
  })
})

describe("workspace runtime client git namespace", () => {
  test("drives the worktree routes and surfaces route errors", async () => {
    await withWorkspace(async (directory) => {
      const server = app()
      const client = createWorkspaceRuntimeClient({
        baseUrl: "http://localhost/",
        fetch: ((input: string | URL | Request, init?: RequestInit) => server.request(input, init)) as typeof fetch,
      })
      await writeFile(path.join(directory, "mod.md"), "one\nchanged\n")

      await client.git.stage({ paths: ["mod.md"] })
      expect((await client.git.status()).staged.map((entry) => entry.path)).toEqual(["mod.md"])
      await client.git.unstage({ paths: ["mod.md"] })
      expect((await client.git.status()).staged).toEqual([])

      await expect(client.git.commitStaged({ message: "nothing" })).rejects.toMatchObject({ status: 400 })
      await client.git.stage({ paths: ["mod.md"] })
      const committed = await client.git.commitStaged({ message: "via client" })
      expect(committed.commit).toBe(await git(directory, ["rev-parse", "HEAD"]))
      expect((await client.git.log({ limit: 1 })).commits.map((commit) => commit.subject)).toEqual(["via client"])

      const pushFailure = await client.git.push({ setUpstream: true }).catch((err: unknown) => err)
      expect(pushFailure).toBeInstanceOf(WorkspaceRuntimeClientError)
      expect((pushFailure as WorkspaceRuntimeClientError).status).toBe(502)
      expect((pushFailure as WorkspaceRuntimeClientError).body).toMatchObject({ error: { code: "git_push_rejected" } })
    })
  })
})

describe("GitWorktreeRoutes workspace scoping", () => {
  test("serves a registered sibling worktree by ?directory= and refuses a directory the runtime is not pinned to", async () => {
    await withWorkspace(async (directory) => {
      const elsewhere = await app().request("http://localhost/api/wr/git/status?directory=%2Fnowhere")
      expect(elsewhere.status).toBe(400)
      await expect(elsewhere.json()).resolves.toMatchObject({ error: { code: "git_invalid_path" } })

      const sibling = await mkdtemp(path.join(tmpdir(), "workspace-runtime-git-sibling-"))
      registerWorkspaceDirectory({ workspaceId: workspaceId(), sessionId: "ses-sibling", directory: sibling })
      try {
        await git(sibling, ["init", "-b", "main"])
        await writeFile(path.join(sibling, "sibling.md"), "hello\n")
        const scoped = await app().request(`http://localhost/api/wr/git/status?directory=${encodeURIComponent(sibling)}`)
        expect(scoped.status).toBe(200)
        const body = await scoped.json() as GitWorktreeStatus
        expect(body.unstaged.map((entry) => [entry.path, entry.status])).toEqual([["sibling.md", "untracked"]])
        // The pinned worktree is untouched: its own status still describes `directory`.
        expect((await status()).unstaged).toEqual([])
        expect(directory).not.toBe(sibling)
      } finally {
        unregisterWorkspaceDirectory({ workspaceId: workspaceId(), sessionId: "ses-sibling" })
        await rm(sibling, { recursive: true, force: true })
      }
    })
  })
})
