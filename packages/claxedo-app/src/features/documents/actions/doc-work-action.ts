import { DocumentRevisionLocatorSchema, type DocumentRevisionLocator } from "@/features/documents/data/docs-api"
import type { Page } from "@/features/documents/data/pages-api"

/**
 * Stable, browser-testable accessible name for the WorkGraph handoff action.
 * Reused verbatim as the menu item's label and `aria-label` so tests and the
 * DOM agree on one name.
 */
export const TURN_REVISION_INTO_WORK_LABEL = "Turn current revision into WorkGraph work"

/**
 * The durable Docs v2 revision locator for a persisted page, or `undefined`
 * when the page carries no durable revision identity.
 *
 * Reads only persisted identifiers from the page record — never editor content
 * — and never fabricates a revision id (the page `version` counter is not a
 * Docs v2 revision). When any of the three ids is missing the action is
 * honestly unavailable and callers must omit/disable the trigger rather than
 * substitute a guess.
 */
export function durableDocumentRevisionForPage(
  page: Pick<Page, "project_id" | "document_id" | "document_revision_id">,
  target?: Readonly<{ directory?: string; repositoryUrl?: string }>,
): DocumentRevisionLocator | undefined {
  const projectId = page.project_id?.trim()
  const documentId = page.document_id?.trim()
  const revisionId = page.document_revision_id?.trim()
  if (!projectId || !documentId || !revisionId) return undefined
  const parsed = DocumentRevisionLocatorSchema.safeParse({
    projectId,
    documentId,
    revisionId,
    ...(target?.directory ? { directory: target.directory } : {}),
    ...(target?.repositoryUrl ? { repositoryUrl: target.repositoryUrl } : {}),
  })
  return parsed.success ? parsed.data : undefined
}
