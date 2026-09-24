import { toAppError } from "../requests"
import type { TranscriptContext } from "./context"
import { prependPage } from "./conversation"

export async function loadOlder(context: TranscriptContext): Promise<void> {
  const cursor = context.olderCursor()
  if (cursor === undefined || context.older.state().kind === "loading") return
  context.older.send({ type: "olderStarted" })
  try {
    const page = await context.server.sessions.older(context.ref, cursor)
    prependPage(context.setData, page)
    context.setOlderCursor(page.olderCursor)
    context.older.send({ type: "olderLanded" })
  } catch (cause) {
    context.older.send({ type: "olderFailed", error: toAppError(cause) })
  }
}
