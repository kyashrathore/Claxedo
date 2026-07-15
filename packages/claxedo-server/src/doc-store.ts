import { randomUUID } from "node:crypto"
import { ClaxedoDB, and, desc, eq } from "./storage/db"
import { ClaxedoDocumentRevisionTable, ClaxedoDocumentTable } from "./storage/schema"
import {
  DocumentStoreError,
  type DocumentAuthor,
  type DocumentScope,
  type DocumentStore,
  type DurableDocument,
  type DurableDocumentRevision,
} from "./document-store"

export * from "./document-store"

type CreateDocumentInput = Readonly<{
  scope: DocumentScope
  title: string
  markdown: string
  contentHash: string
  authoredBy: DocumentAuthor
  authoredAt: number
}>

type AppendDocumentRevisionInput = Readonly<{
  scope: DocumentScope
  documentId: string
  expectedParentRevisionId: string
  title: string
  markdown: string
  contentHash: string
  authoredBy: DocumentAuthor
  authoredAt: number
}>

export function createDocument(input: CreateDocumentInput) {
  const identity = ClaxedoDB.transaction((db) => createDocumentInTransaction(db, input))
  return requireRevision(input.scope, identity.documentId, identity.revisionId)
}

export function appendDocumentRevision(input: AppendDocumentRevisionInput) {
  const revisionId = ClaxedoDB.transaction((db) => appendDocumentRevisionInTransaction(db, input))
  return requireRevision(input.scope, input.documentId, revisionId)
}

export function createDocumentInTransaction(db: ClaxedoDB.Client, input: CreateDocumentInput) {
  const documentId = `document_${randomUUID()}`
  const revisionId = `document_revision_${randomUUID()}`
  db.insert(ClaxedoDocumentTable)
    .values({
      id: documentId,
      org_id: input.scope.orgId,
      project_id: input.scope.projectId,
      title: input.title,
      head_revision_id: revisionId,
      created_at: input.authoredAt,
      updated_at: input.authoredAt,
    })
    .run()
  db.insert(ClaxedoDocumentRevisionTable)
    .values({
      id: revisionId,
      document_id: documentId,
      revision_number: 1,
      title: input.title,
      markdown: input.markdown,
      content_hash: input.contentHash,
      authored_at: input.authoredAt,
      authored_by_type: input.authoredBy.type,
      authored_by_id: input.authoredBy.id,
      created_at: input.authoredAt,
    })
    .run()
  return { documentId, revisionId }
}

export function appendDocumentRevisionInTransaction(db: ClaxedoDB.Client, input: AppendDocumentRevisionInput) {
  const document = db
    .select()
    .from(ClaxedoDocumentTable)
    .where(
      and(
        eq(ClaxedoDocumentTable.id, input.documentId),
        eq(ClaxedoDocumentTable.org_id, input.scope.orgId),
        eq(ClaxedoDocumentTable.project_id, input.scope.projectId),
      ),
    )
    .get()
  if (!document) throw new DocumentStoreError("document_not_found", "Document not found")
  if (document.head_revision_id !== input.expectedParentRevisionId) {
    throw new DocumentStoreError("document_revision_conflict", "Document head changed", document.head_revision_id)
  }
  const parent = db
    .select()
    .from(ClaxedoDocumentRevisionTable)
    .where(
      and(
        eq(ClaxedoDocumentRevisionTable.id, document.head_revision_id),
        eq(ClaxedoDocumentRevisionTable.document_id, document.id),
      ),
    )
    .get()
  if (!parent) throw new DocumentStoreError("document_not_found", "Document head revision not found")
  const revisionId = `document_revision_${randomUUID()}`
  const updated = db
    .update(ClaxedoDocumentTable)
    .set({
      title: input.title,
      head_revision_id: revisionId,
      updated_at: input.authoredAt,
    })
    .where(
      and(
        eq(ClaxedoDocumentTable.id, document.id),
        eq(ClaxedoDocumentTable.org_id, input.scope.orgId),
        eq(ClaxedoDocumentTable.project_id, input.scope.projectId),
        eq(ClaxedoDocumentTable.head_revision_id, input.expectedParentRevisionId),
      ),
    )
    .run()
  if (updated.changes !== 1) {
    const current = db
      .select({ head_revision_id: ClaxedoDocumentTable.head_revision_id })
      .from(ClaxedoDocumentTable)
      .where(eq(ClaxedoDocumentTable.id, document.id))
      .get()
    throw new DocumentStoreError("document_revision_conflict", "Document head changed", current?.head_revision_id)
  }
  db.insert(ClaxedoDocumentRevisionTable)
    .values({
      id: revisionId,
      document_id: document.id,
      revision_number: parent.revision_number + 1,
      parent_revision_id: parent.id,
      title: input.title,
      markdown: input.markdown,
      content_hash: input.contentHash,
      authored_at: input.authoredAt,
      authored_by_type: input.authoredBy.type,
      authored_by_id: input.authoredBy.id,
      created_at: input.authoredAt,
    })
    .run()
  return revisionId
}

export function findDocument(orgId: string, documentId: string) {
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoDocumentTable)
      .where(and(eq(ClaxedoDocumentTable.id, documentId), eq(ClaxedoDocumentTable.org_id, orgId)))
      .get(),
  )
}

export function listDocuments(scope: DocumentScope) {
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoDocumentTable)
      .where(and(eq(ClaxedoDocumentTable.org_id, scope.orgId), eq(ClaxedoDocumentTable.project_id, scope.projectId)))
      .orderBy(desc(ClaxedoDocumentTable.updated_at), ClaxedoDocumentTable.id)
      .all()
      .map(documentDto),
  )
}

export function getDocumentRevision(scope: DocumentScope, documentId: string, revisionId: string) {
  const document = findDocument(scope.orgId, documentId)
  if (!document || document.project_id !== scope.projectId) return
  const revision = ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoDocumentRevisionTable)
      .where(
        and(eq(ClaxedoDocumentRevisionTable.id, revisionId), eq(ClaxedoDocumentRevisionTable.document_id, documentId)),
      )
      .get(),
  )
  if (!revision) return
  return {
    projectId: document.project_id,
    documentId: document.id,
    documentTitle: revision.title,
    revisionId: revision.id,
    revisionNumber: revision.revision_number,
    ...(revision.parent_revision_id ? { parentRevisionId: revision.parent_revision_id } : {}),
    markdown: revision.markdown,
    contentHash: revision.content_hash,
    authoredAt: revision.authored_at,
    authoredBy: {
      type: revision.authored_by_type as DocumentAuthor["type"],
      id: revision.authored_by_id,
    },
  } satisfies DurableDocumentRevision
}

export function getDocumentHeadRevision(scope: DocumentScope, documentId: string) {
  const document = findDocument(scope.orgId, documentId)
  if (!document || document.project_id !== scope.projectId) return
  return getDocumentRevision(scope, document.id, document.head_revision_id)
}

function documentDto(document: typeof ClaxedoDocumentTable.$inferSelect) {
  return {
    documentId: document.id,
    projectId: document.project_id,
    title: document.title,
    headRevisionId: document.head_revision_id,
    createdAt: document.created_at,
    updatedAt: document.updated_at,
  } satisfies DurableDocument
}

function requireRevision(scope: DocumentScope, documentId: string, revisionId: string) {
  const revision = getDocumentRevision(scope, documentId, revisionId)
  if (!revision) throw new DocumentStoreError("document_not_found", "Document revision not found")
  return revision
}

export const sqliteDocumentStore: DocumentStore = {
  create: createDocument,
  appendRevision: appendDocumentRevision,
  list: listDocuments,
  find: (scope, documentId) => {
    const document = findDocument(scope.orgId, documentId)
    if (!document) return
    return documentDto(document)
  },
  getRevision: getDocumentRevision,
  getHeadRevision: getDocumentHeadRevision,
}
