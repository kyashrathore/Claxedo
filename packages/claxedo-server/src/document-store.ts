import { z } from "zod"

export type DocumentScope = Readonly<{ orgId: string; projectId: string }>
export type DocumentAuthor = Readonly<{ type: "user" | "agent" | "system"; id: string }>

export const DurableDocumentRevisionSchema = z.strictObject({
  projectId: z.string(),
  documentId: z.string(),
  documentTitle: z.string(),
  revisionId: z.string(),
  revisionNumber: z.number().int().positive(),
  parentRevisionId: z.string().optional(),
  markdown: z.string(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  authoredAt: z.number(),
  authoredBy: z.strictObject({
    type: z.enum(["user", "agent", "system"]),
    id: z.string(),
  }),
})

export type DurableDocumentRevision = Readonly<z.infer<typeof DurableDocumentRevisionSchema>>

export const DurableDocumentSchema = z.strictObject({
  documentId: z.string(),
  projectId: z.string(),
  title: z.string(),
  headRevisionId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type DurableDocument = Readonly<z.infer<typeof DurableDocumentSchema>>

export type DocumentStoreErrorCode =
  | "document_not_found"
  | "document_revision_conflict"
  | "document_content_hash_mismatch"

export class DocumentStoreError extends Error {
  override readonly name = "DocumentStoreError"

  constructor(
    readonly code: DocumentStoreErrorCode,
    message: string,
    readonly currentRevisionId?: string,
  ) {
    super(message)
  }
}

export type DocumentStore = Readonly<{
  create(
    input: Readonly<{
      scope: DocumentScope
      title: string
      markdown: string
      contentHash: string
      authoredBy: DocumentAuthor
      authoredAt: number
    }>,
  ): Promise<DurableDocumentRevision> | DurableDocumentRevision
  appendRevision(
    input: Readonly<{
      scope: DocumentScope
      documentId: string
      expectedParentRevisionId: string
      title: string
      markdown: string
      contentHash: string
      authoredBy: DocumentAuthor
      authoredAt: number
    }>,
  ): Promise<DurableDocumentRevision> | DurableDocumentRevision
  list(scope: DocumentScope): Promise<readonly DurableDocument[]> | readonly DurableDocument[]
  find(
    scope: Readonly<{ orgId: string }>,
    documentId: string,
  ): Promise<DurableDocument | undefined> | DurableDocument | undefined
  getRevision(
    scope: DocumentScope,
    documentId: string,
    revisionId: string,
  ): Promise<DurableDocumentRevision | undefined> | DurableDocumentRevision | undefined
  getHeadRevision(
    scope: DocumentScope,
    documentId: string,
  ): Promise<DurableDocumentRevision | undefined> | DurableDocumentRevision | undefined
}>
