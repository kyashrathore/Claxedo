import { describe, expect, test } from "bun:test"
import { createDocsApi } from "./docs-api"

const revision = {
  projectId: "project_1",
  documentId: "document_1",
  documentTitle: "Launch Claxedo",
  revisionId: "revision_2",
  revisionNumber: 2,
  parentRevisionId: "revision_1",
  markdown: "# Launch\n\nShip it.",
  contentHash: "a".repeat(64),
  authoredAt: 200,
  authoredBy: { type: "agent" as const, id: "agent_1" },
}

describe("Docs v2 API", () => {
  test("reads the exact durable revision from the authorized Docs route", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const api = createDocsApi({
      baseUrl: "https://control.test/",
      request: async (input, init) => {
        calls.push({ url: String(input), init })
        return Response.json(revision)
      },
    })

    await expect(api.revisionForWork({
      projectId: "project_1",
      documentId: "document_1",
      revisionId: "revision_2",
      targetStreamId: "stream_1",
    })).resolves.toEqual(revision)
    expect(calls).toEqual([{
      url: "https://control.test/api/claxedo/docs/document_1/revisions/revision_2?project_id=project_1",
      init: { method: "GET", headers: { Accept: "application/json" } },
    }])
  })

  test("rejects a different revision identity instead of handing it to WorkGraph", async () => {
    const api = createDocsApi({
      baseUrl: "https://control.test",
      request: async () => Response.json({ ...revision, revisionId: "revision_3" }),
    })

    await expect(api.revisionForWork({
      projectId: "project_1",
      documentId: "document_1",
      revisionId: "revision_2",
    })).rejects.toMatchObject({
      name: "DocsApiError",
      code: "revision_identity_mismatch",
    })
  })

  test("surfaces missing and invalid durable revisions without a legacy source", async () => {
    const missing = createDocsApi({
      baseUrl: "https://control.test",
      request: async () => Response.json({ error: "not_found" }, { status: 404 }),
    })
    await expect(missing.revisionForWork({
      projectId: "project_1",
      documentId: "document_1",
      revisionId: "revision_2",
    })).rejects.toMatchObject({ code: "revision_unavailable", status: 404 })

    const invalid = createDocsApi({
      baseUrl: "https://control.test",
      request: async () => Response.json({ ...revision, markdown: "" }),
    })
    await expect(invalid.revisionForWork({
      projectId: "project_1",
      documentId: "document_1",
      revisionId: "revision_2",
    })).rejects.toMatchObject({ code: "invalid_revision" })
  })
})
