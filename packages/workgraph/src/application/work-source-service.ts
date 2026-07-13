import { createHash } from "node:crypto"
import type { OperationID, WorkGraphContext, WorkSourceID, WorkSourceRevisionID } from "../contracts"
import type { WorkSourcePort } from "../ports"

export function createWorkSourceService(port: WorkSourcePort) {
  return {
    createManual: (context: WorkGraphContext, input: Readonly<{ operationId: OperationID; title: string; content: string }>) =>
      port.createManual(context, input),
    reviseManual: (
      context: WorkGraphContext,
      input: Readonly<{
        operationId: OperationID
        workSourceId: WorkSourceID
        expectedRevisionId: WorkSourceRevisionID
        title?: string
        content: string
      }>,
    ) => port.reviseManual(context, input),
    readSource: (context: WorkGraphContext, workSourceId: WorkSourceID) =>
      port.readSource(context, { workSourceId }),
    readRevision: (context: WorkGraphContext, workSourceId: WorkSourceID, revisionId: WorkSourceRevisionID) =>
      port.readRevision(context, { workSourceId, revisionId }),
  }
}

export function hashWorkSourceContent(content: string) {
  return createHash("sha256").update(content).digest("hex")
}

/** Builds bounded model context while the immutable revision retains all text. */
export function workSourceModelExcerpt(content: string, maxCharacters: number) {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) throw new Error("maxCharacters must be a positive integer")
  if (content.length <= maxCharacters) return { content, truncated: false as const }
  return { content: content.slice(0, maxCharacters), truncated: true as const, originalCharacters: content.length }
}
