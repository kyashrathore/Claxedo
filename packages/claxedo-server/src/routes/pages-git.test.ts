import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"
import { mkdirSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Hono } from "hono"

const mocks = {
  sandboxFetch: vi.fn(),
}

vi.mock("../sandbox-target-fetch", () => ({
  sandboxFetch: mocks.sandboxFetch,
}))

const root = path.join(realpathSync(os.tmpdir()), `page-git-routes-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { ClaxedoDB } = await import("../storage/db")
ClaxedoDB.Drizzle()
const { ensureWorkspace } = await import("../workspace-store")
const { PagesRoutes } = await import("./pages")

const app = new Hono().route("/pages", PagesRoutes())

const workspace = {
  id: "ws_git",
  org_id: "org_1",
  kind: "cloud" as const,
  directory: path.join(root, "repo"),
  project_id: "proj_git",
}

function runtimeOk() {
  mocks.sandboxFetch.mockImplementation(async (_ws: unknown, requestPath: string, init?: RequestInit) => {
    if (requestPath.startsWith("/api/wr/git/snapshot")) {
      return Response.json({
        repoRoot: workspace.directory,
        head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        branch: "main",
        blobSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        tracked: true,
        dirty: false,
      })
    }
    if (requestPath.startsWith("/file/content")) {
      return Response.json({ type: "text", content: "# Source\n\nHello" })
    }
    if (requestPath === "/api/wr/git/commit" && init?.method === "POST") {
      return Response.json({
        commit: "cccccccccccccccccccccccccccccccccccccccc",
        blobSha: "dddddddddddddddddddddddddddddddddddddddd",
      })
    }
    return Response.json({ error: { code: "unexpected_runtime_path", message: requestPath } }, { status: 500 })
  })
}

async function createSourcedPage() {
  const res = await app.request("http://localhost/pages/from-repo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Source",
      directory: workspace.directory,
      project_id: "proj_git",
      workspace_id: "ws_git",
      path: "docs/source.md",
    }),
  })
  if (res.status !== 201) throw new Error(await res.text())
  return await res.json() as { id: string; content: string; commit_status: string; base_commit: string; base_blob_sha: string }
}

describe("PagesRoutes git source", () => {
  beforeEach(async () => {
    mocks.sandboxFetch.mockReset()
    mkdirSync(workspace.directory, { recursive: true })
    const ensured = await ensureWorkspace({
      workspaceId: workspace.id,
      org_id: workspace.org_id,
      directory: workspace.directory,
      kind: workspace.kind,
      project_id: workspace.project_id,
    })
    if (!ensured) throw new Error("failed to seed workspace")
    runtimeOk()
  })

  afterAll(async () => {
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    if (prev === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = prev
  })

  test("creates a sourced page from a clean runtime snapshot", async () => {
    const page = await createSourcedPage()

    expect(page.commit_status).toBe("sourced")
    expect(page.base_commit).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    expect(page.base_blob_sha).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    expect(page.content).toContain("Source")
    expect(mocks.sandboxFetch).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_git" }),
      "/api/wr/git/snapshot?path=docs%2Fsource.md",
      undefined,
      {},
    )
  })

  test("passes dirty source conflicts through on create", async () => {
    mocks.sandboxFetch.mockImplementation(async (_ws: unknown, requestPath: string) => {
      if (requestPath.startsWith("/api/wr/git/snapshot")) {
        return Response.json({
          error: { code: "git_source_conflict", message: "source file is dirty" },
          currentCommit: "head",
          currentBlobSha: "blob",
          dirty: true,
        }, { status: 409 })
      }
      return Response.json({ type: "text", content: "" })
    })

    const res = await app.request("http://localhost/pages/from-repo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory: workspace.directory, project_id: "proj_git", workspace_id: "ws_git", path: "docs/source.md" }),
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({ dirty: true })
  })

  test("commits sourced page markdown and refreshes metadata", async () => {
    const page = await createSourcedPage()
    const res = await app.request(`http://localhost/pages/${page.id}/git/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "docs: update source" }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { commit_status: string; base_commit: string; last_materialized_blob_sha: string }
    expect(body.commit_status).toBe("committed")
    expect(body.base_commit).toBe("cccccccccccccccccccccccccccccccccccccccc")
    expect(body.last_materialized_blob_sha).toBe("dddddddddddddddddddddddddddddddddddddddd")
    expect(mocks.sandboxFetch).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_git" }),
      "/api/wr/git/commit",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("docs: update source"),
      }),
      {},
    )
  })

  test("passes stale commit conflicts through", async () => {
    const page = await createSourcedPage()
    mocks.sandboxFetch.mockImplementation(async (_ws: unknown, requestPath: string) => {
      if (requestPath === "/api/wr/git/commit") {
        return Response.json({
          error: { code: "git_source_conflict", message: "source file changed before commit" },
          currentCommit: "new-head",
          currentBlobSha: "new-blob",
          dirty: false,
        }, { status: 409 })
      }
      return Response.json({ error: { code: "unexpected_runtime_path", message: requestPath } }, { status: 500 })
    })

    const res = await app.request(`http://localhost/pages/${page.id}/git/commit`, { method: "POST" })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({ currentCommit: "new-head" })
  })

  test("passes traversal rejection through from runtime snapshot", async () => {
    mocks.sandboxFetch.mockImplementation(async (_ws: unknown, requestPath: string) => {
      if (requestPath.startsWith("/api/wr/git/snapshot")) {
        return Response.json({
          error: { code: "git_source_invalid_path", message: "path is outside git repository" },
        }, { status: 400 })
      }
      return Response.json({ type: "text", content: "" })
    })

    const res = await app.request("http://localhost/pages/from-repo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory: workspace.directory, project_id: "proj_git", workspace_id: "ws_git", path: "../secret.md" }),
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "git_source_invalid_path" },
    })
  })
})
