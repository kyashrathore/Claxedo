import { toAppError } from "@/server"
import type { TranscriptContext } from "./context"
import { upsertPart } from "./conversation"

function isHeaderOnly(context: TranscriptContext, messageId: string, partId: string): boolean {
  const part = context.data.parts[messageId]?.find((item) => item.id === partId)
  return part?.type === "tool" && part.headerOnly === true
}

export function loadPart(context: TranscriptContext, messageId: string, partId: string): Promise<void> {
  if (!isHeaderOnly(context, messageId, partId)) return Promise.resolve()
  const pending = context.partReads.get(partId)
  if (pending) return pending
  const read = context.server.sessions
    .part(context.ref, messageId, partId)
    .then(
      (part) => {
        if (isHeaderOnly(context, messageId, partId)) upsertPart(context.setData, part)
      },
      (cause) => console.error("A tool's output could not be read", { sessionId: context.ref.sessionId, messageId, partId, error: toAppError(cause) }),
    )
    .finally(() => context.partReads.delete(partId))
  context.partReads.set(partId, read)
  return read
}
