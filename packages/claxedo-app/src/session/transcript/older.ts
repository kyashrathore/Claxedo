import { batch } from "solid-js"
import { toAppError, type AppError, type TranscriptPage } from "@/server"
import type { TranscriptContext } from "./context"
import { prependPage } from "./conversation"

type OlderOutcome = { readonly page: TranscriptPage } | { readonly error: AppError } | undefined

export function loadOlder(context: TranscriptContext): Promise<void> {
  context.olderRead.current ??= readOlderPage(context).then((outcome) => {
    context.olderRead.current = undefined
    landOlderPage(context, outcome)
  })
  return context.olderRead.current
}

async function readOlderPage(context: TranscriptContext): Promise<OlderOutcome> {
  const cursor = context.olderCursor()
  if (cursor === undefined) return undefined
  context.older.send({ type: "olderStarted" })
  try {
    return { page: await context.server.sessions.older(context.ref, cursor) }
  } catch (cause) {
    return { error: toAppError(cause) }
  }
}

function landOlderPage(context: TranscriptContext, outcome: OlderOutcome): void {
  if (!outcome) return
  if ("error" in outcome) {
    context.older.send({ type: "olderFailed", error: outcome.error })
    return
  }
  batch(() => {
    prependPage(context.setData, outcome.page)
    context.setOlderCursor(outcome.page.olderCursor)
    context.older.send({ type: "olderLanded" })
  })
}
