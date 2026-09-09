import { z } from "zod"
import { DocumentIndexEntrySchema } from "@claxedo/server-core/documents/index-contract"
import { toDocumentVersion, toSnapshotID } from "@claxedo/server-core/documents/port"

/**
 * What the local installation broker answers with, as the hosted side must read it.
 *
 * `LocalDocumentBrokerRoutes` in `@claxedo/workspace-runtime` forwards the local
 * `LocalInstallationDocumentBroker` response body unchanged, so these schemas are
 * the hosted mirror of what that app returns. They live here — one module beside
 * the relay client — because the hosted backend used to re-guess the shape at
 * every call site (`typeof value === "object"` and then an `as` into the expected
 * type), which meant a drifted broker produced a `TypeError` deep inside a caller
 * rather than a rejected response at the boundary.
 */

const DocumentVersionSchema = z.string().min(1).transform(toDocumentVersion)

const SnapshotRefSchema = z.object({
  id: z.string().min(1).transform(toSnapshotID),
  sha256: z.string(),
  size: z.number(),
  reason: z.string(),
  actor: z.object({ type: z.enum(["user", "agent", "system"]), id: z.string() }),
  sessionId: z.string().optional(),
  createdAt: z.number(),
  pins: z.array(z.string()).readonly(),
})

export const LocalDocumentReadSchema = z.object({
  markdown: z.string(),
  version: DocumentVersionSchema,
  modifiedAt: z.number(),
})

/** The `read` operation: the current entry plus the document as the installation has it. */
export const LocalDocumentReadResponseSchema = z.object({
  entry: DocumentIndexEntrySchema,
  read: LocalDocumentReadSchema,
})

/** The `list` operation. */
export const LocalDocumentIndexResponseSchema = z.array(DocumentIndexEntrySchema)

/** The `write` operation: the installation's `WriteResult` for the document. */
export const LocalDocumentWriteResponseSchema = z.object({
  markdown: z.string(),
  version: DocumentVersionSchema,
  modifiedAt: z.number(),
  snapshot: SnapshotRefSchema.optional(),
})

/**
 * Broker responses fail as the domain error the caller already documents rather
 * than as a raw `ZodError`, so a drifted installation stays a "local document is
 * unavailable" condition instead of a 500 with a schema dump.
 */
export function parseLocalDocumentResponse<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  message: string,
): z.output<T> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error(message)
  return parsed.data
}
