import { toAppError } from "@/server"
import type { TranscriptContext } from "./context"
import { prependPage } from "./conversation"

export function loadOlder(context: TranscriptContext): Promise<void> {
  context.olderRead.current ??= readOlder(context).finally(() => {
    context.olderRead.current = undefined
  })
  return context.olderRead.current
}

async function readOlder(context: TranscriptContext): Promise<void> {
  const cursor = context.olderCursor()
  if (cursor === undefined) return
  context.older.send({ type: "olderStarted" })
  try {
    const page = await context.server.sessions.older(context.ref, cursor)
    prependPage(context.setData, page)
    context.setOlderCursor(page.olderCursor)
    context.setOlderPages((count) => count + 1)
    context.older.send({ type: "olderLanded" })
  } catch (cause) {
    context.older.send({ type: "olderFailed", error: toAppError(cause) })
  }
}
