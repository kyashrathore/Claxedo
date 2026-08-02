import type { DocumentSummary } from "@/features/documents/data/documents-api"
import { DocumentWorkSourceRequestSchema, type DocumentWorkSourceRequest } from "./document-work-source"

/**
 * Stable, browser-testable accessible name for the WorkGraph handoff action.
 * Reused verbatim as the menu item's label and `aria-label` so tests and the
 * DOM agree on one name.
 */
export const TURN_DOCUMENT_INTO_WORK_LABEL = "Turn current document into WorkGraph work"

/**
 * The canonical index identity for WorkGraph intake, or `undefined` when the
 * document is not addressable. Snapshot identity is intentionally absent: it
 * is created from the current workspace file by the server at intake time.
 */
export function workSourceForDocument(
  document: Pick<DocumentSummary, "project_id" | "id" | "placement_kind">,
  target?: Readonly<{ directory?: string; repositoryUrl?: string }>,
): DocumentWorkSourceRequest | undefined {
  const projectId = document.project_id?.trim()
  const documentId = document.id?.trim()
  if (!projectId || !documentId) return undefined
  const parsed = DocumentWorkSourceRequestSchema.safeParse({
    projectId,
    documentId,
    placement: document.placement_kind,
    ...(target?.directory ? { directory: target.directory } : {}),
    ...(target?.repositoryUrl ? { repositoryUrl: target.repositoryUrl } : {}),
  })
  return parsed.success ? parsed.data : undefined
}
