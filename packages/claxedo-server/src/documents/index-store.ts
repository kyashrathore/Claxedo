import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm"
import { ClaxedoDB } from "../adapters/storage/db"
import {
  ClaxedoDocumentIndexTable,
  ClaxedoDocumentStatusTable,
  ClaxedoLocalProjectTable,
} from "../adapters/storage/document-index.sql"
import {
  defaultDocumentStatuses,
  DocumentIndexEntrySchema,
  type DocumentIndexEntry,
  type DocumentIndexScope,
} from "./index-contract"

export { DocumentIndexEntrySchema } from "./index-contract"
export type { DocumentIndexEntry, DocumentIndexScope } from "./index-contract"

export class DocumentIndexNotFoundError extends Error {
  readonly code = "document_index_not_found"

  constructor(readonly documentId: string) {
    super(`Document ${documentId} was not found`)
    this.name = "DocumentIndexNotFoundError"
  }
}

export class DocumentStatusTransitionError extends Error {
  constructor(
    readonly code: "document_status_not_found" | "document_status_transition_not_allowed",
    message: string,
  ) {
    super(message)
    this.name = "DocumentStatusTransitionError"
  }
}

const documentIndexProjection = {
  id: ClaxedoDocumentIndexTable.id,
  org_id: ClaxedoDocumentIndexTable.org_id,
  project_id: ClaxedoDocumentIndexTable.project_id,
  display_name: ClaxedoDocumentIndexTable.display_name,
  origin_kind: ClaxedoDocumentIndexTable.origin_kind,
  placement_kind: ClaxedoDocumentIndexTable.placement_kind,
  placement_id: ClaxedoDocumentIndexTable.placement_id,
  managed_relative_path: ClaxedoDocumentIndexTable.managed_relative_path,
  repository_id: ClaxedoDocumentIndexTable.repository_id,
  workspace_id: ClaxedoDocumentIndexTable.workspace_id,
  repository_relative_path: ClaxedoDocumentIndexTable.repository_relative_path,
  branch: ClaxedoDocumentIndexTable.branch,
  status: ClaxedoDocumentIndexTable.status,
  session_id: ClaxedoDocumentIndexTable.session_id,
  archived_at: ClaxedoDocumentIndexTable.archived_at,
  created_at: ClaxedoDocumentIndexTable.created_at,
  updated_at: ClaxedoDocumentIndexTable.updated_at,
  last_opened_at: ClaxedoDocumentIndexTable.last_opened_at,
  last_known_file_version: ClaxedoDocumentIndexTable.last_known_file_version,
}

export function createDocumentIndexEntry(input: DocumentIndexEntry) {
  const entry = DocumentIndexEntrySchema.parse(input)
  ClaxedoDB.use((db) => db.insert(ClaxedoDocumentIndexTable).values(entry).run())
  return entry
}

export function removeDocumentIndexEntry(scope: DocumentIndexScope, documentId: string) {
  ClaxedoDB.use((db) =>
    db
      .delete(ClaxedoDocumentIndexTable)
      .where(and(
        eq(ClaxedoDocumentIndexTable.id, documentId),
        eq(ClaxedoDocumentIndexTable.org_id, scope.orgId),
        eq(ClaxedoDocumentIndexTable.project_id, scope.projectId),
      ))
      .run(),
  )
}

export function listDocumentIndex(
  scope: DocumentIndexScope,
  options: { archived?: "active" | "archived" | "all" } = {},
) {
  const archive = options.archived === "all"
    ? undefined
    : options.archived === "archived"
      ? isNotNull(ClaxedoDocumentIndexTable.archived_at)
      : isNull(ClaxedoDocumentIndexTable.archived_at)
  return ClaxedoDB.use((db) =>
    db
      .select(documentIndexProjection)
      .from(ClaxedoDocumentIndexTable)
      .where(and(
        eq(ClaxedoDocumentIndexTable.org_id, scope.orgId),
        eq(ClaxedoDocumentIndexTable.project_id, scope.projectId),
        archive,
      ))
      .orderBy(desc(ClaxedoDocumentIndexTable.updated_at), desc(ClaxedoDocumentIndexTable.id))
      .all()
      .map((entry) => DocumentIndexEntrySchema.parse(entry)),
  )
}

export function resolveLocalProjectId(directory: string) {
  const normalized = canonicalDirectory(directory)
  const project_id = `project_${randomUUID().replaceAll("-", "")}`
  ClaxedoDB.use((db) =>
    db
      .insert(ClaxedoLocalProjectTable)
      .values({ directory: normalized, project_id, created_at: new Date().toISOString() })
      .onConflictDoNothing({ target: ClaxedoLocalProjectTable.directory })
      .run(),
  )
  const project = ClaxedoDB.use((db) =>
    db
      .select({ project_id: ClaxedoLocalProjectTable.project_id })
      .from(ClaxedoLocalProjectTable)
      .where(eq(ClaxedoLocalProjectTable.directory, normalized))
      .get(),
  )
  if (!project) throw new Error(`Failed to resolve local project for ${normalized}`)
  return project.project_id
}

export function lookupDocumentIndexEntry(scope: DocumentIndexScope, documentId: string) {
  const row = ClaxedoDB.use((db) =>
    db
      .select(documentIndexProjection)
      .from(ClaxedoDocumentIndexTable)
      .where(and(
        eq(ClaxedoDocumentIndexTable.id, documentId),
        eq(ClaxedoDocumentIndexTable.org_id, scope.orgId),
        eq(ClaxedoDocumentIndexTable.project_id, scope.projectId),
      ))
      .get(),
  )
  if (!row) return { state: "missing" as const }
  const entry = DocumentIndexEntrySchema.parse(row)
  if (entry.archived_at) return { state: "archived" as const, entry }
  return { state: "available" as const, entry }
}

export function findDocumentIndexEntry(orgId: string, documentId: string) {
  const row = ClaxedoDB.use((db) =>
    db
      .select(documentIndexProjection)
      .from(ClaxedoDocumentIndexTable)
      .where(and(
        eq(ClaxedoDocumentIndexTable.id, documentId),
        eq(ClaxedoDocumentIndexTable.org_id, orgId),
      ))
      .get(),
  )
  return row ? DocumentIndexEntrySchema.parse(row) : undefined
}

export function findRepositoryDocumentIndexEntry(scope: DocumentIndexScope, repositoryId: string) {
  const row = ClaxedoDB.use((db) =>
    db
      .select(documentIndexProjection)
      .from(ClaxedoDocumentIndexTable)
      .where(and(
        eq(ClaxedoDocumentIndexTable.org_id, scope.orgId),
        eq(ClaxedoDocumentIndexTable.project_id, scope.projectId),
        eq(ClaxedoDocumentIndexTable.origin_kind, "repository"),
        eq(ClaxedoDocumentIndexTable.repository_id, repositoryId),
      ))
      .get(),
  )
  return row ? DocumentIndexEntrySchema.parse(row) : undefined
}

const DocumentMetadataUpdateSchema = z.object({
  display_name: z.string().trim().min(1).optional(),
  session_id: z.string().trim().min(1).nullable().optional(),
  last_known_file_version: z.string().min(1).nullable().optional(),
  updated_at: z.string().datetime().optional(),
}).strict().refine((input) => Object.keys(input).some((key) => key !== "updated_at"), {
  message: "At least one document metadata field is required",
})

export function updateDocumentIndexMetadata(
  scope: DocumentIndexScope,
  documentId: string,
  input: z.input<typeof DocumentMetadataUpdateSchema>,
) {
  const update = DocumentMetadataUpdateSchema.parse(input)
  const existing = lookupDocumentIndexEntry(scope, documentId)
  if (existing.state === "missing") throw new DocumentIndexNotFoundError(documentId)
  ClaxedoDB.use((db) =>
    db
      .update(ClaxedoDocumentIndexTable)
      .set({ ...update, updated_at: update.updated_at ?? new Date().toISOString() })
      .where(and(
        eq(ClaxedoDocumentIndexTable.id, documentId),
        eq(ClaxedoDocumentIndexTable.org_id, scope.orgId),
        eq(ClaxedoDocumentIndexTable.project_id, scope.projectId),
      ))
      .run(),
  )
  const updated = lookupDocumentIndexEntry(scope, documentId)
  if (updated.state === "missing") throw new DocumentIndexNotFoundError(documentId)
  return updated.entry
}

const RepositoryRelocationSchema = z.object({
  repository_id: z.string().min(1),
  repository_relative_path: z.string().min(1),
  last_known_file_version: z.string().min(1),
  branch: z.string().min(1).nullable().optional(),
}).strict()

export function relocateRepositoryDocumentIndexEntry(
  scope: DocumentIndexScope,
  documentId: string,
  input: z.input<typeof RepositoryRelocationSchema>,
) {
  const relocation = RepositoryRelocationSchema.parse(input)
  const existing = lookupDocumentIndexEntry(scope, documentId)
  if (existing.state === "missing") throw new DocumentIndexNotFoundError(documentId)
  if (existing.entry.origin_kind !== "repository") {
    throw new DocumentIndexNotFoundError(documentId)
  }
  ClaxedoDB.use((db) =>
    db
      .update(ClaxedoDocumentIndexTable)
      .set({ ...relocation, updated_at: new Date().toISOString() })
      .where(and(
        eq(ClaxedoDocumentIndexTable.id, documentId),
        eq(ClaxedoDocumentIndexTable.org_id, scope.orgId),
        eq(ClaxedoDocumentIndexTable.project_id, scope.projectId),
      ))
      .run(),
  )
  const relocated = lookupDocumentIndexEntry(scope, documentId)
  if (relocated.state === "missing") throw new DocumentIndexNotFoundError(documentId)
  return relocated.entry
}

const RepositoryMoveSchema = z.object({
  repository_id: z.string().min(1),
  workspace_id: z.string().min(1),
  repository_relative_path: z.string().min(1),
  last_known_file_version: z.string().min(1),
  branch: z.string().min(1).nullable().optional(),
}).strict()

export function moveManagedDocumentIndexToRepository(
  scope: DocumentIndexScope,
  documentId: string,
  input: z.input<typeof RepositoryMoveSchema>,
) {
  const move = RepositoryMoveSchema.parse(input)
  const existing = lookupDocumentIndexEntry(scope, documentId)
  if (existing.state === "missing") throw new DocumentIndexNotFoundError(documentId)
  if (existing.entry.origin_kind === "repository") {
    if (
      existing.entry.repository_id !== move.repository_id ||
      existing.entry.workspace_id !== move.workspace_id ||
      existing.entry.repository_relative_path !== move.repository_relative_path
    ) throw new DocumentIndexNotFoundError(documentId)
    return existing.entry
  }
  const result = ClaxedoDB.use((db) =>
    db
      .update(ClaxedoDocumentIndexTable)
      .set({
        origin_kind: "repository",
        managed_relative_path: null,
        repository_id: move.repository_id,
        workspace_id: move.workspace_id,
        repository_relative_path: move.repository_relative_path,
        branch: move.branch ?? null,
        last_known_file_version: move.last_known_file_version,
        updated_at: new Date().toISOString(),
      })
      .where(and(
        eq(ClaxedoDocumentIndexTable.id, documentId),
        eq(ClaxedoDocumentIndexTable.org_id, scope.orgId),
        eq(ClaxedoDocumentIndexTable.project_id, scope.projectId),
        eq(ClaxedoDocumentIndexTable.origin_kind, "managed"),
      ))
      .run(),
  )
  const moved = lookupDocumentIndexEntry(scope, documentId)
  if (
    moved.state === "missing" ||
    moved.entry.origin_kind !== "repository" ||
    moved.entry.repository_id !== move.repository_id ||
    moved.entry.workspace_id !== move.workspace_id ||
    moved.entry.repository_relative_path !== move.repository_relative_path ||
    (result.changes !== 0 && result.changes !== 1)
  ) throw new DocumentIndexNotFoundError(documentId)
  return moved.entry
}
export function restoreRepositoryMoveToManaged(
  scope: DocumentIndexScope,
  documentId: string,
  input: Readonly<{ managed_relative_path: string; last_known_file_version: string }>,
) {
  ClaxedoDB.use((db) =>
    db
      .update(ClaxedoDocumentIndexTable)
      .set({
        origin_kind: "managed",
        managed_relative_path: input.managed_relative_path,
        repository_id: null,
        workspace_id: null,
        repository_relative_path: null,
        branch: null,
        last_known_file_version: input.last_known_file_version,
        updated_at: new Date().toISOString(),
      })
      .where(and(
        eq(ClaxedoDocumentIndexTable.id, documentId),
        eq(ClaxedoDocumentIndexTable.org_id, scope.orgId),
        eq(ClaxedoDocumentIndexTable.project_id, scope.projectId),
        eq(ClaxedoDocumentIndexTable.origin_kind, "repository"),
      ))
      .run(),
  )
  const restored = lookupDocumentIndexEntry(scope, documentId)
  if (restored.state === "missing" || restored.entry.origin_kind !== "managed") throw new DocumentIndexNotFoundError(documentId)
  return restored.entry
}

export function archiveDocumentIndexEntry(scope: DocumentIndexScope, documentId: string, archivedAt = new Date().toISOString()) {
  const existing = lookupDocumentIndexEntry(scope, documentId)
  if (existing.state === "missing") throw new DocumentIndexNotFoundError(documentId)
  if (existing.state === "archived") return existing.entry
  const timestamp = z.string().datetime().parse(archivedAt)
  ClaxedoDB.use((db) =>
    db
      .update(ClaxedoDocumentIndexTable)
      .set({ archived_at: timestamp, updated_at: timestamp })
      .where(and(
        eq(ClaxedoDocumentIndexTable.id, documentId),
        eq(ClaxedoDocumentIndexTable.org_id, scope.orgId),
        eq(ClaxedoDocumentIndexTable.project_id, scope.projectId),
      ))
      .run(),
  )
  const archived = lookupDocumentIndexEntry(scope, documentId)
  if (archived.state === "missing") throw new DocumentIndexNotFoundError(documentId)
  return archived.entry
}

export function restoreDocumentIndexEntry(scope: DocumentIndexScope, documentId: string, restoredAt = new Date().toISOString()) {
  const existing = lookupDocumentIndexEntry(scope, documentId)
  if (existing.state === "missing") throw new DocumentIndexNotFoundError(documentId)
  if (existing.state === "available") return existing.entry
  const timestamp = z.string().datetime().parse(restoredAt)
  ClaxedoDB.use((db) =>
    db
      .update(ClaxedoDocumentIndexTable)
      .set({ archived_at: null, updated_at: timestamp })
      .where(and(
        eq(ClaxedoDocumentIndexTable.id, documentId),
        eq(ClaxedoDocumentIndexTable.org_id, scope.orgId),
        eq(ClaxedoDocumentIndexTable.project_id, scope.projectId),
      ))
      .run(),
  )
  const restored = lookupDocumentIndexEntry(scope, documentId)
  if (restored.state === "missing") throw new DocumentIndexNotFoundError(documentId)
  return restored.entry
}

export function listDocumentStatuses(projectId: string) {
  z.string().min(1).parse(projectId)
  ClaxedoDB.transaction((db) => {
    const existing = db
      .select({ id: ClaxedoDocumentStatusTable.id })
      .from(ClaxedoDocumentStatusTable)
      .where(eq(ClaxedoDocumentStatusTable.project_id, projectId))
      .limit(1)
      .get()
    if (existing) return
    defaultDocumentStatuses.forEach((status) => {
      db.insert(ClaxedoDocumentStatusTable)
        .values({
          ...status,
          project_id: projectId,
          transitions: JSON.stringify(status.transitions),
        })
        .onConflictDoNothing()
        .run()
    })
  })
  return ClaxedoDB.use((db) =>
    db
      .select({
        id: ClaxedoDocumentStatusTable.id,
        name: ClaxedoDocumentStatusTable.name,
        color: ClaxedoDocumentStatusTable.color,
        position: ClaxedoDocumentStatusTable.position,
        transitions: ClaxedoDocumentStatusTable.transitions,
      })
      .from(ClaxedoDocumentStatusTable)
      .where(eq(ClaxedoDocumentStatusTable.project_id, projectId))
      .orderBy(ClaxedoDocumentStatusTable.position)
      .all(),
  )
}

export function transitionDocumentStatus(
  scope: DocumentIndexScope,
  documentId: string,
  targetStatus: string,
  transitionedAt = new Date().toISOString(),
) {
  const existing = lookupDocumentIndexEntry(scope, documentId)
  if (existing.state === "missing") throw new DocumentIndexNotFoundError(documentId)
  const statuses = listDocumentStatuses(scope.projectId)
  const target = statuses.find((status) => status.id === targetStatus)
  if (!target) {
    throw new DocumentStatusTransitionError("document_status_not_found", `Status ${targetStatus} does not exist`)
  }
  const current = statuses.find((status) => status.id === existing.entry.status)
  if (!current || !z.array(z.string()).parse(JSON.parse(current.transitions)).includes(targetStatus)) {
    throw new DocumentStatusTransitionError(
      "document_status_transition_not_allowed",
      `Transition from ${existing.entry.status} to ${targetStatus} is not allowed`,
    )
  }
  const timestamp = z.string().datetime().parse(transitionedAt)
  ClaxedoDB.use((db) =>
    db
      .update(ClaxedoDocumentIndexTable)
      .set({ status: targetStatus, updated_at: timestamp })
      .where(and(
        eq(ClaxedoDocumentIndexTable.id, documentId),
        eq(ClaxedoDocumentIndexTable.org_id, scope.orgId),
        eq(ClaxedoDocumentIndexTable.project_id, scope.projectId),
      ))
      .run(),
  )
  const transitioned = lookupDocumentIndexEntry(scope, documentId)
  if (transitioned.state === "missing") throw new DocumentIndexNotFoundError(documentId)
  return transitioned.entry
}

function canonicalDirectory(directory: string) {
  const value = z.string().trim().min(1).parse(directory)
  try {
    return path.resolve(realpathSync.native?.(value) ?? realpathSync(value))
  } catch {
    return path.resolve(value)
  }
}
