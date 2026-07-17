import { z } from "zod"
import { turnDocumentIntoWork as handoffDocument } from "@/features/documents/app-ports"
import { DocumentWorkSourceRequestSchema } from "./document-work-source"

export {
  DocumentSnapshotForWorkSchema,
  DocumentSnapshotLocatorSchema,
  DocumentWorkSourceRequestSchema,
  type DocumentSnapshotForWork,
  type DocumentSnapshotLocator,
  type DocumentWorkSourceRequest,
} from "./document-work-source"
export { TURN_DOCUMENT_INTO_WORK_LABEL, workSourceForDocument } from "./doc-work-action"

/**
 * UI and agent callers identify the indexed document. The server creates and
 * pins the immutable snapshot; callers never provide content or hashes.
 */
export function turnDocumentIntoWork(input: z.input<typeof DocumentWorkSourceRequestSchema>) {
  return handoffDocument(DocumentWorkSourceRequestSchema.parse(input))
}
