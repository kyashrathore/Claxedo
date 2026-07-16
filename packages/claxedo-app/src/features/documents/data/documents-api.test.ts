import { beforeEach, describe, expect, mock, test } from "bun:test"

const calls: Array<{ url: string; init?: RequestInit }> = []
const responses: Response[] = []

mock.module("@/platform/api/api", () => ({
  authFetch: async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return responses.shift() ?? Response.json({})
  },
  getClaxedoServerUrl: () => "http://test.local",
  normalizeUrl: (value?: string) => value,
}))

const { documentsApi } = await import("./documents-api")

beforeEach(() => {
  calls.length = 0
  responses.length = 0
})

describe("documentsApi", () => {
  test("list fetches metadata only from the index route", async () => {
    responses.push(Response.json([{ id: "doc-1", display_name: "Plan", project_id: "p1" }]))
    await expect(documentsApi.list({ projectId: "p1" })).resolves.toEqual([
      expect.objectContaining({ id: "doc-1", display_name: "Plan" }),
    ])
    expect(calls.map((call) => call.url)).toEqual(["http://test.local/documents?project_id=p1&archived=active"])
  })

  test("open performs the two-step summary then content request", async () => {
    responses.push(
      Response.json({ id: "doc-1", display_name: "Plan", project_id: "p1", archived_at: null }),
      Response.json({ markdown: "# Plan\n", version: "opaque-v1", modifiedAt: 1 }),
    )
    await expect(documentsApi.open("doc-1")).resolves.toMatchObject({
      id: "doc-1",
      displayName: "Plan",
      markdown: "# Plan\n",
      version: "opaque-v1",
    })
    expect(calls.map((call) => call.url)).toEqual([
      "http://test.local/documents/doc-1",
      "http://test.local/documents/doc-1/content",
    ])
  })

  test("agentOpen requests an honest canonical path for the current session", async () => {
    responses.push(
      Response.json({ document_id: "doc-1", display_name: "Plan", path: "/data/documents/p1/doc-1/plan.md" }),
    )
    await expect(documentsApi.agentOpen("doc-1", "session-1")).resolves.toEqual({
      document_id: "doc-1",
      display_name: "Plan",
      path: "/data/documents/p1/doc-1/plan.md",
    })
    expect(calls[0]?.url).toBe("http://test.local/documents/doc-1/agent-open")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ session_id: "session-1" }))
  })

  test("runtime conflict resolution sends only the human choice and session identity", async () => {
    responses.push(Response.json({ path: "/workspace/plan.md", version: "opaque-v3" }))
    await expect(documentsApi.resolveRuntimeConflict("doc-1", {
      sessionId: "session-1",
      choice: "draft",
    })).resolves.toEqual({ path: "/workspace/plan.md", version: "opaque-v3" })
    expect(calls[0]?.url).toBe("http://test.local/documents/doc-1/runtime-conflict/resolve")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ session_id: "session-1", choice: "draft" }))
  })

  test("save sends display name and Markdown in one conditional request", async () => {
    responses.push(Response.json({ markdown: "body", version: "opaque-v2", modifiedAt: 2 }))
    await expect(
      documentsApi.save("doc/1", {
        displayName: "Renamed",
        markdown: "body",
        expectedVersion: "opaque-v1",
      }),
    ).resolves.toEqual({ ok: true, version: "opaque-v2" })
    expect(calls[0]?.url).toBe("http://test.local/documents/doc%2F1/content")
    expect(calls[0]?.init?.method).toBe("PUT")
    expect(new Headers(calls[0]?.init?.headers).get("If-Match")).toBe("opaque-v1")
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ display_name: "Renamed", markdown: "body" }))
  })

  test("save maps 409 into a conflict containing current disk and metadata", async () => {
    responses.push(
      Response.json({ currentVersion: "opaque-v2" }, { status: 409 }),
      Response.json({ id: "doc-1", display_name: "Other", project_id: "p1" }),
      Response.json({ markdown: "disk", version: "opaque-v2", modifiedAt: 2 }),
    )
    await expect(
      documentsApi.save("doc-1", {
        displayName: "Mine",
        markdown: "human",
        expectedVersion: "opaque-v1",
      }),
    ).resolves.toEqual({
      ok: false,
      kind: "conflict",
      currentVersion: "opaque-v2",
      current: { displayName: "Other", markdown: "disk" },
    })
    expect(calls).toHaveLength(3)
  })

  test("history lists snapshots and restores with the current opaque version", async () => {
    responses.push(
      Response.json([{ id: "snapshot-1", reason: "document.written", pins: [] }]),
      Response.json({ markdown: "restored", version: "opaque-v3", modifiedAt: 3 }),
    )
    await expect(documentsApi.snapshots("doc-1")).resolves.toEqual([expect.objectContaining({ id: "snapshot-1" })])
    await expect(documentsApi.restoreSnapshot("doc-1", "snapshot/1", "opaque-v2")).resolves.toMatchObject({
      markdown: "restored",
      version: "opaque-v3",
    })
    expect(calls[1]?.url).toBe("http://test.local/documents/doc-1/snapshots/snapshot%2F1/restore")
    expect(calls[1]?.init?.method).toBe("POST")
    expect(new Headers(calls[1]?.init?.headers).get("If-Match")).toBe("opaque-v2")
  })

  test("moves a managed document to a repository without changing its identity", async () => {
    responses.push(Response.json({ id: "doc-1", origin_kind: "repository", workspace_id: "workspace-1" }))
    await expect(
      documentsApi.moveToRepository("doc-1", {
        workspaceId: "workspace-1",
        path: "docs/plan.md",
      }),
    ).resolves.toMatchObject({ id: "doc-1", origin_kind: "repository" })
    expect(calls[0]?.url).toBe("http://test.local/documents/doc-1/move-to-repository")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ workspace_id: "workspace-1", path: "docs/plan.md" }))
  })

  test("imports repository metadata without copying content and exports exact bytes", async () => {
    responses.push(
      Response.json({ id: "doc-1", origin_kind: "repository", repository_relative_path: "docs/plan.md" }),
      new Response("\ufeff# Exact\r\nbody", { headers: { "content-type": "text/markdown" } }),
    )
    await documentsApi.createFromRepository({
      projectId: "project-1",
      directory: "/repo",
      workspaceId: "workspace-1",
      path: "docs/plan.md",
      displayName: "Plan",
    })
    await expect(documentsApi.exportBytes("doc-1")).resolves.toEqual(new TextEncoder().encode("\ufeff# Exact\r\nbody"))
    expect(calls[0]?.url).toBe("http://test.local/documents/from-repo")
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({
        project_id: "project-1",
        directory: "/repo",
        workspace_id: "workspace-1",
        path: "docs/plan.md",
        display_name: "Plan",
      }),
    )
  })

  test("lists status metadata and posts an allowed transition", async () => {
    responses.push(
      Response.json([{ id: "draft", name: "Draft", color: "#fff", position: 0, transitions: '["done"]' }]),
      Response.json({ id: "doc-1", status: "done" }),
    )
    await expect(documentsApi.listStatuses({ projectId: "project-1" })).resolves.toEqual([
      expect.objectContaining({ id: "draft", transitions: ["done"] }),
    ])
    await expect(documentsApi.transitionStatus("doc-1", "done")).resolves.toMatchObject({ status: "done" })
    expect(calls[1]?.url).toBe("http://test.local/documents/doc-1/status")
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ status: "done" }))
  })

  test("missing documents surface a typed recovery state", async () => {
    responses.push(Response.json({ error: { code: "document_not_found" } }, { status: 404 }))
    await expect(documentsApi.open("missing")).rejects.toMatchObject({ code: "document_not_found", status: 404 })
  })

  test("archived summary stops before content and surfaces a typed recovery state", async () => {
    responses.push(Response.json({ id: "doc-1", display_name: "Archived", project_id: "p1", archived_at: "now" }))
    await expect(documentsApi.open("doc-1")).rejects.toMatchObject({ code: "document_archived", status: 410 })
    expect(calls).toHaveLength(1)
  })
})
