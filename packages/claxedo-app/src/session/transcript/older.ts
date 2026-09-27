import { batch } from "solid-js"
import { toAppError, type AppError, type TranscriptPage } from "@/server"
import type { TranscriptContext } from "./context"
import { prependPage } from "./conversation"

type OlderOutcome = { readonly page: TranscriptPage } | { readonly error: AppError } | undefined

export type OlderWindow = "page" | "turn"

export function loadOlder(context: TranscriptContext, window: OlderWindow): Promise<void> {
  context.olderRead.current ??= readOlderPage(context, window).then((outcome) => {
    context.olderRead.current = undefined
    landOlderPage(context, outcome)
  })
  return context.olderRead.current
}

function readOlderWindow(context: TranscriptContext, cursor: string, window: OlderWindow): Promise<TranscriptPage> {
  const { sessions } = context.server
  return window === "turn" ? sessions.wholeTurn(context.ref, cursor) : sessions.older(context.ref, cursor)
}

async function readOlderPage(context: TranscriptContext, window: OlderWindow): Promise<OlderOutcome> {
  const cursor = context.olderCursor()
  if (cursor === undefined) return undefined
  context.older.send({ type: "olderStarted" })
  try {
    return { page: await readOlderWindow(context, cursor, window) }
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
