import { ConvexHttpClient } from "convex/browser"
import { z } from "zod"
import { cliServiceUser } from "../control-plane/cli-session-token"
import type { SignedControlPlaneAuth } from "../control-plane/auth"
import {
  DocumentStoreError,
  DurableDocumentRevisionSchema,
  DurableDocumentSchema,
  type DocumentStore,
} from "../document-store"
import { documentConvexApi } from "./convex-api"

export type DocumentConvexExecutor = Readonly<{
  mutation: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>
}>

type Input = Readonly<{
  url?: string
  serviceToken: string
  auth: SignedControlPlaneAuth
  executor?: DocumentConvexExecutor
}>

const FailureSchema = z.strictObject({
  ok: z.literal(false),
  code: z.enum(["document_not_found", "document_revision_conflict", "document_content_hash_mismatch"]),
  message: z.string(),
  currentRevisionId: z.string().optional(),
})
const RevisionResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), revision: DurableDocumentRevisionSchema }),
  FailureSchema,
])
const DocumentResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), document: DurableDocumentSchema.nullable() }),
  FailureSchema,
])
const DocumentListResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), documents: z.array(DurableDocumentSchema) }),
  FailureSchema,
])

export function createConvexDocumentStore(input: Input): DocumentStore {
  const url = input.url?.trim()
  if (!input.executor && !url) throw new Error("Convex document storage URL is required")
  const executor = input.executor ?? createExecutor(url!)
  const common = {
    service_token: input.serviceToken,
    user: cliServiceUser(input.auth),
  }
  const revision = async (fn: unknown, args: Record<string, unknown>) => {
    const result = RevisionResultSchema.parse(await executor.mutation(fn, { ...common, ...args }))
    if (result.ok) return result.revision
    throw new DocumentStoreError(result.code, result.message, result.currentRevisionId)
  }

  return {
    create: (request) =>
      revision(documentConvexApi.docs.createForService, {
        ...contentArgs(request),
        document_id: `document_${crypto.randomUUID()}`,
        revision_id: `document_revision_${crypto.randomUUID()}`,
      }),
    appendRevision: (request) =>
      revision(documentConvexApi.docs.appendRevisionForService, {
        ...contentArgs(request),
        document_id: request.documentId,
        revision_id: `document_revision_${crypto.randomUUID()}`,
        expected_parent_revision_id: request.expectedParentRevisionId,
      }),
    list: async (scope) => {
      const result = DocumentListResultSchema.parse(
        await executor.mutation(documentConvexApi.docs.listForService, {
          ...common,
          organization_id: scope.orgId,
          project_id: scope.projectId,
        }),
      )
      if (result.ok) return result.documents
      throw new DocumentStoreError(result.code, result.message, result.currentRevisionId)
    },
    find: async (scope, documentId) => {
      const result = DocumentResultSchema.parse(
        await executor.mutation(documentConvexApi.docs.findForService, {
          ...common,
          organization_id: scope.orgId,
          document_id: documentId,
        }),
      )
      if (result.ok) return result.document ?? undefined
      throw new DocumentStoreError(result.code, result.message, result.currentRevisionId)
    },
    getRevision: (scope, documentId, revisionId) =>
      revision(documentConvexApi.docs.getRevisionForService, {
        organization_id: scope.orgId,
        project_id: scope.projectId,
        document_id: documentId,
        revision_id: revisionId,
      }).catch((error) => {
        if (error instanceof DocumentStoreError && error.code === "document_not_found") return undefined
        throw error
      }),
    getHeadRevision: (scope, documentId) =>
      revision(documentConvexApi.docs.getHeadRevisionForService, {
        organization_id: scope.orgId,
        project_id: scope.projectId,
        document_id: documentId,
      }).catch((error) => {
        if (error instanceof DocumentStoreError && error.code === "document_not_found") return undefined
        throw error
      }),
  }
}

function contentArgs(input: Parameters<DocumentStore["create"]>[0]) {
  return {
    organization_id: input.scope.orgId,
    project_id: input.scope.projectId,
    title: input.title,
    markdown: input.markdown,
    content_hash: input.contentHash,
    authored_by_type: input.authoredBy.type,
    authored_by_id: input.authoredBy.id,
    authored_at: input.authoredAt,
  }
}

function createExecutor(url: string): DocumentConvexExecutor {
  const client = new ConvexHttpClient(url)
  return { mutation: (fn, args) => client.mutation(fn as never, args as never) }
}
