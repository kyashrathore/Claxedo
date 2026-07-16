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
