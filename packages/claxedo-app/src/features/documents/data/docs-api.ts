import { z } from "zod"

const contentHash = z.string().regex(/^[a-f0-9]{64}$/i)

export const DocumentRevisionLocatorSchema = z.strictObject({
  projectId: z.string().trim().min(1),
  documentId: z.string().trim().min(1),
  revisionId: z.string().trim().min(1),
  targetStreamId: z.string().trim().min(1).optional(),
  directory: z.string().trim().min(1).optional(),
  repositoryUrl: z.string().url().optional(),
})
export type DocumentRevisionLocator = z.infer<typeof DocumentRevisionLocatorSchema>

/** One immutable revision returned by the Docs v2 source-of-truth API. */
export const DurableDocumentRevisionSchema = z.strictObject({
  projectId: z.string().trim().min(1),
  documentId: z.string().trim().min(1),
  documentTitle: z.string().trim().min(1),
  revisionId: z.string().trim().min(1),
  revisionNumber: z.number().int().positive(),
  parentRevisionId: z.string().trim().min(1).optional(),
  markdown: z.string().refine((value) => value.trim().length > 0, "Document revision must contain non-whitespace markdown"),
  contentHash,
  authoredAt: z.number().int().nonnegative(),
  authoredBy: z.strictObject({
    type: z.enum(["user", "agent", "system"]),
    id: z.string().trim().min(1),
  }),
})
export type DurableDocumentRevision = z.infer<typeof DurableDocumentRevisionSchema>

export const DocumentRevisionForWorkSchema = DurableDocumentRevisionSchema.extend({
  targetStreamId: z.string().trim().min(1).optional(),
  directory: z.string().trim().min(1).optional(),
  repositoryUrl: z.string().url().optional(),
})
export type DocumentRevisionForWork = z.infer<typeof DocumentRevisionForWorkSchema>

export type DocsApiErrorCode = "request_failed" | "revision_unavailable" | "invalid_revision" | "revision_identity_mismatch"

export class DocsApiError extends Error {
  override readonly name = "DocsApiError"

  constructor(
    readonly code: DocsApiErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export function createDocsApi(input: Readonly<{ baseUrl: string; request: typeof fetch }>) {
  const baseUrl = input.baseUrl.replace(/\/$/, "")

  return {
    async revisionForWork(locatorInput: z.input<typeof DocumentRevisionLocatorSchema>) {
      const locator = DocumentRevisionLocatorSchema.parse(locatorInput)
      const url = new URL(
        `${baseUrl}/api/claxedo/docs/${encodeURIComponent(locator.documentId)}/revisions/${encodeURIComponent(locator.revisionId)}`,
      )
      url.searchParams.set("project_id", locator.projectId)
      const response = await input.request(String(url), {
        method: "GET",
        headers: { Accept: "application/json" },
      }).catch((error) => {
        throw new DocsApiError("request_failed", error instanceof Error ? error.message : "Docs v2 is unavailable")
      })
      if (!response.ok) {
        throw new DocsApiError(
          "revision_unavailable",
          `Docs v2 revision request failed (${response.status})`,
          response.status,
        )
      }
      const value = await response.json().catch(() => {
        throw new DocsApiError("invalid_revision", "Docs v2 returned invalid JSON", response.status)
      })
      const revision = DurableDocumentRevisionSchema.safeParse(value)
      if (!revision.success) {
        throw new DocsApiError("invalid_revision", revision.error.message, response.status)
      }
      if (
        revision.data.projectId !== locator.projectId ||
        revision.data.documentId !== locator.documentId ||
        revision.data.revisionId !== locator.revisionId
      ) {
        throw new DocsApiError(
          "revision_identity_mismatch",
          "Docs v2 returned a different document revision than the one requested",
          response.status,
        )
      }
      return revision.data
    },
  }
}
