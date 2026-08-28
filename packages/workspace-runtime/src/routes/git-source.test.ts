import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { GitSourceRoutes } from "./git-source"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import { managedWorkspaceSessionAccessPolicy } from "../session-access-policy"

const execFileAsync = promisify(execFile)

async function git(directory: string, args: string[]) {
  const result = await execFileAsync("git", args, { cwd: directory })
  return result.stdout.trim()
}

async function withGitRepo(fn: (directory: string) => Promise<void>, input: { objectFormat?: "sha1" | "sha256" } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "workspace-runtime-git-source-"))
  const previous = process.env.WORKSPACE_RUNTIME_DIRECTORY
  try {
    process.env.WORKSPACE_RUNTIME_DIRECTORY = directory
    await git(directory, input.objectFormat === "sha256" ? ["init", "--object-format=sha256"] : ["init"])
    await git(directory, ["config", "user.email", "test@example.com"])
    await git(directory, ["config", "user.name", "Test User"])
    await writeFile(path.join(directory, "doc.md"), "before\n")
    await git(directory, ["add", "."])
    await git(directory, ["commit", "-m", "initial"])
    await fn(directory)
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_RUNTIME_DIRECTORY
    else process.env.WORKSPACE_RUNTIME_DIRECTORY = previous
    await rm(directory, { recursive: true, force: true })
  }
}

function app() {
  return new Hono().route("/api/wr/git", GitSourceRoutes())
}

describe("GitSourceRoutes", () => {
  test("rejects a verified viewer commit before changing the worktree", async () => {
    await withGitRepo(async (directory) => {
      const now = Math.floor(Date.now() / 1000)
      const app = new Hono<{ Variables: RelayHostAuthContext }>()
      app.use("*", async (c, next) => {
        c.set("relayHostAuth", {
          iss: "workspace-relay",
          aud: "workspace-host-service",
          principal_kind: "user",
          actor_id: "viewer_1",
          actor_kind: "human",
          org_id: "org_1",
          workspace_id: "ws_1",
          host_id: "host_1",
          role: "viewer",
          access: "cloud",
          backing: "cloud-vm",
          exp: now + 60,
          iat: now,
          jti: "jti_1",
          parent_jti: "rat_1",
        })
        return await next()
      })
      app.route("/", GitSourceRoutes({
        sessionAccessPolicy: managedWorkspaceSessionAccessPolicy({ requireActor: true }),
      }))

      const response = await app.request("/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: path.join(directory, "doc.md"), content: "after\n", message: "mutate" }),
      })
      expect(response.status).toBe(403)
      expect(await readFile(path.join(directory, "doc.md"), "utf8")).toBe("before\n")
      expect(await git(directory, ["rev-list", "--count", "HEAD"])).toBe("1")
    })
  })

  test("returns a clean tracked snapshot", async () => {
    await withGitRepo(async () => {
      const res = await app().request("http://localhost/api/wr/git/snapshot?path=doc.md")
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toMatchObject({
        tracked: true,
        dirty: false,
      })
    })
  })

  test("rejects dirty and untracked snapshots", async () => {
    await withGitRepo(async (directory) => {
      await writeFile(path.join(directory, "doc.md"), "dirty\n")
      const dirty = await app().request("http://localhost/api/wr/git/snapshot?path=doc.md")
      expect(dirty.status).toBe(409)

      await writeFile(path.join(directory, "new.md"), "new\n")
      const untracked = await app().request("http://localhost/api/wr/git/snapshot?path=new.md")
      expect(untracked.status).toBe(409)
    })
  })

  test("commits a clean matching file and rejects stale bases", async () => {
    await withGitRepo(async (directory) => {
      const snapshot = await (await app().request("http://localhost/api/wr/git/snapshot?path=doc.md")).json() as {
        head: string
        blobSha: string
      }
      const committed = await app().request("http://localhost/api/wr/git/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "doc.md",
          content: "after\n",
          message: "update doc",
          expected: { baseCommit: snapshot.head, baseBlobSha: snapshot.blobSha },
        }),
      })
      expect(committed.status).toBe(200)
      expect(await git(directory, ["log", "-1", "--pretty=%s"])).toBe("update doc")

      const stale = await app().request("http://localhost/api/wr/git/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "doc.md",
          content: "stale\n",
          message: "stale doc",
          expected: { baseCommit: snapshot.head, baseBlobSha: snapshot.blobSha },
        }),
      })
      expect(stale.status).toBe(409)
    })
  })

  test("serializes concurrent same-base commits", async () => {
    await withGitRepo(async (directory) => {
      const snapshot = await (await app().request("http://localhost/api/wr/git/snapshot?path=doc.md")).json() as {
        head: string
        blobSha: string
      }
      const request = (content: string, message: string) => app().request("http://localhost/api/wr/git/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "doc.md",
          content,
          message,
          expected: { baseCommit: snapshot.head, baseBlobSha: snapshot.blobSha },
        }),
      })

      const responses = await Promise.all([request("first\n", "first"), request("second\n", "second")])
      expect(responses.map((res) => res.status).sort()).toEqual([200, 409])
      expect(["first\n", "second\n"]).toContain(await readFile(path.join(directory, "doc.md"), "utf8"))
      expect(await git(directory, ["status", "--porcelain"])).toBe("")
    })
  })

  test("restores the worktree when git commit fails after writing", async () => {
    await withGitRepo(async (directory) => {
      await mkdir(path.join(directory, ".git", "hooks"), { recursive: true })
      await writeFile(path.join(directory, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
      const snapshot = await (await app().request("http://localhost/api/wr/git/snapshot?path=doc.md")).json() as {
        head: string
        blobSha: string
      }

      const res = await app().request("http://localhost/api/wr/git/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "doc.md",
          content: "after failed commit\n",
          message: "blocked",
          expected: { baseCommit: snapshot.head, baseBlobSha: snapshot.blobSha },
        }),
      })

      expect(res.status).toBe(400)
      expect(await readFile(path.join(directory, "doc.md"), "utf8")).toBe("before\n")
      expect(await git(directory, ["status", "--porcelain"])).toBe("")
    })
  })

  test("rejects escaping paths", async () => {
    await withGitRepo(async () => {
      const res = await app().request("http://localhost/api/wr/git/snapshot?path=../doc.md")
      expect(res.status).toBe(400)
      const commit = await app().request("http://localhost/api/wr/git/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "../doc.md",
          content: "escape\n",
          message: "escape",
          expected: { baseCommit: "head", baseBlobSha: "blob" },
        }),
      })
      expect(commit.status).toBe(400)
    })
  })

  test("supports sha256 git object ids", async () => {
    await withGitRepo(async () => {
      const res = await app().request("http://localhost/api/wr/git/snapshot?path=doc.md")
      expect(res.status).toBe(200)
      const body = await res.json() as { blobSha: string; tracked: boolean }
      expect(body.tracked).toBe(true)
      expect(body.blobSha).toHaveLength(64)
    }, { objectFormat: "sha256" })
  })
})
