import { z } from "zod"
import { turnDocumentRevisionIntoWork as handoffDocumentRevision } from "@/features/documents/app-ports"
import { DocumentRevisionLocatorSchema } from "@/features/documents/data/docs-api"

export {
  DocumentRevisionForWorkSchema,
  DocumentRevisionLocatorSchema,
  type DocumentRevisionForWork,
  type DocumentRevisionLocator,
} from "@/features/documents/data/docs-api"

/**
 * UI and agent callers identify a durable Docs revision; they never provide
 * markdown, hashes, or author provenance themselves.
 */
export function turnDocumentRevisionIntoWork(input: z.input<typeof DocumentRevisionLocatorSchema>) {
  return handoffDocumentRevision(DocumentRevisionLocatorSchema.parse(input))
}
