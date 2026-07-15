import { describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "../control-plane/auth"
import { DocumentStoreError } from "../document-store"
import { createConvexDocumentStore } from "./convex-store"

const auth: SignedControlPlaneAuth = {
  mode: "signed",
  token: "caller-token",
  user: {
    subject: "user_1",
    tokenIdentifier: "issuer|user_1",
    issuer: "https://clerk.test",
  },
}
const revision = {
  projectId: "project_1",
  documentId: "document_1",
  documentTitle: "Launch",
  revisionId: "document_revision_1",
  revisionNumber: 1,
  markdown: "# Launch",
  contentHash: "a".repeat(64),
  authoredAt: 10,
  authoredBy: { type: "user" as const, id: "user_1" },
}
const document = {
  documentId: revision.documentId,
  projectId: revision.projectId,
  title: revision.documentTitle,
  headRevisionId: revision.revisionId,
  createdAt: 10,
  updatedAt: 10,
}

describe("Convex document store", () => {
  test("sends the verified actor and exact tenant scope through the service boundary", async () => {
    const mutation = vi.fn(async () => ({ ok: true, revision }))
    const store = createConvexDocumentStore({
      auth,
      serviceToken: "service-secret",
      executor: { mutation },
    })

    await expect(
      store.create({
        scope: { orgId: "org_1", projectId: "project_1" },
        title: "Launch",
        markdown: revision.markdown,
        contentHash: revision.contentHash,
        authoredBy: revision.authoredBy,
        authoredAt: revision.authoredAt,
      }),
    ).resolves.toEqual(revision)

    expect(mutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        service_token: "service-secret",
        user: {
          token_identifier: "issuer|user_1",
          subject: "user_1",
          issuer: "https://clerk.test",
        },
        organization_id: "org_1",
        project_id: "project_1",
        authored_by_type: "user",
        authored_by_id: "user_1",
        document_id: expect.stringMatching(/^document_/),
        revision_id: expect.stringMatching(/^document_revision_/),
      }),
    )
  })

  test("preserves the typed current-head conflict from Convex", async () => {
    const store = createConvexDocumentStore({
      auth,
      serviceToken: "service-secret",
      executor: {
        mutation: vi.fn(async () => ({
          ok: false,
          code: "document_revision_conflict",
          message: "Document head changed",
          currentRevisionId: "document_revision_current",
        })),
      },
    })

    await expect(
      store.appendRevision({
        scope: { orgId: "org_1", projectId: "project_1" },
        documentId: "document_1",
        expectedParentRevisionId: "document_revision_stale",
        title: "Launch",
        markdown: "# Launch v2",
        contentHash: "b".repeat(64),
        authoredBy: revision.authoredBy,
        authoredAt: 11,
      }),
    ).rejects.toMatchObject({
      name: "DocumentStoreError",
      code: "document_revision_conflict",
      currentRevisionId: "document_revision_current",
    } satisfies Partial<DocumentStoreError>)
  })

  test("lists project documents and resolves the current head through explicit Convex operations", async () => {
    const mutation = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, documents: [document] })
      .mockResolvedValueOnce({ ok: true, revision })
    const store = createConvexDocumentStore({
      auth,
      serviceToken: "service-secret",
      executor: { mutation },
    })

    await expect(store.list({ orgId: "org_1", projectId: "project_1" })).resolves.toEqual([document])
    await expect(store.getHeadRevision({ orgId: "org_1", projectId: "project_1" }, "document_1")).resolves.toEqual(
      revision,
    )
    expect(mutation).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ organization_id: "org_1", project_id: "project_1" }),
    )
    expect(mutation).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ organization_id: "org_1", project_id: "project_1", document_id: "document_1" }),
    )
  })

  test("rejects malformed storage responses instead of fabricating a revision", async () => {
    const store = createConvexDocumentStore({
      auth,
      serviceToken: "service-secret",
      executor: { mutation: vi.fn(async () => ({ ok: true, revision: { documentId: "partial" } })) },
    })

    await expect(
      store.getRevision({ orgId: "org_1", projectId: "project_1" }, "document_1", "document_revision_1"),
    ).rejects.toThrow()
    await expect(store.list({ orgId: "org_1", projectId: "project_1" })).rejects.toThrow()
  })

  test("returns no current head when Convex reports an indistinguishable not-found result", async () => {
    const store = createConvexDocumentStore({
      auth,
      serviceToken: "service-secret",
      executor: {
        mutation: vi.fn(async () => ({
          ok: false,
          code: "document_not_found",
          message: "Document revision not found",
        })),
      },
    })

    await expect(
      store.getHeadRevision({ orgId: "org_1", projectId: "project_1" }, "document_missing"),
    ).resolves.toBeUndefined()
  })
})
