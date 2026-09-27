import { batch } from "solid-js"
import { toAppError, type TranscriptPage } from "@/server"
import type { TranscriptContext } from "./context"
import { lastUserMessageId, mergeTurn } from "./conversation"
import { applyTranscriptEvent } from "./events"
import { isOptimisticMessage } from "./merge"

function hasOlderLoaded(context: TranscriptContext, page: TranscriptPage): boolean {
  const first = page.entries[0]?.info.id
  return first !== undefined && context.data.messages.some((message) => !isOptimisticMessage(message) && message.id < first)
}

export function adoptOlderCursor(context: TranscriptContext, page: TranscriptPage): void {
  if (!hasOlderLoaded(context, page)) context.setOlderCursor(page.olderCursor)
}

function unfold(context: TranscriptContext, userMessageId: string): void {
  const folded = new Map(context.data.folded)
  if (folded.delete(userMessageId)) context.setData("folded", folded)
}

function readTurnOnce(context: TranscriptContext, userMessageId: string, read: () => Promise<void>): Promise<void> {
  const pending = context.turnReads.get(userMessageId)
  if (pending) return pending
  const started = read().finally(() => context.turnReads.delete(userMessageId))
  context.turnReads.set(userMessageId, started)
  return started
}

function openTurn(context: TranscriptContext, before: string | undefined): Promise<TranscriptPage> {
  return context.server.sessions.openTurn(context.ref, context.deps.pageShape(), before)
}

function landLatest(context: TranscriptContext, userMessageId: string, page: TranscriptPage | undefined): void {
  const current = context.phase.state()
  if (current.kind !== "completing") return
  batch(() => {
    if (page) {
      mergeTurn(context.setData, page)
      context.latestTurnRead.current = page
      adoptOlderCursor(context, page)
    }
    unfold(context, userMessageId)
    for (const event of current.held) applyTranscriptEvent(context, event)
    context.phase.send({ type: "latestLanded" })
  })
}

async function openNewestTurn(context: TranscriptContext, userMessageId: string): Promise<void> {
  context.phase.send({ type: "latestStarted" })
  if (context.phase.state().kind !== "completing") return
  try {
    landLatest(context, userMessageId, await openTurn(context, undefined))
  } catch (cause) {
    console.error("The latest turn could not be opened", { sessionId: context.ref.sessionId, error: toAppError(cause) })
    landLatest(context, userMessageId, undefined)
  }
}

async function readBackTo(context: TranscriptContext, userMessageId: string): Promise<TranscriptPage | undefined> {
  let before: string | undefined
  do {
    const page = await openTurn(context, before)
    const first = page.entries[0]?.info.id
    if (first === undefined || first < userMessageId) return undefined
    if (first === userMessageId) return page
    before = page.olderCursor
  } while (before !== undefined)
  return undefined
}

async function openOlder(context: TranscriptContext, userMessageId: string, before: string | undefined): Promise<void> {
  try {
    const page = before === undefined ? await readBackTo(context, userMessageId) : await openTurn(context, before)
    if (!page) return
    batch(() => {
      mergeTurn(context.setData, page)
      unfold(context, userMessageId)
    })
  } catch (cause) {
    console.error("A folded turn could not be opened", { sessionId: context.ref.sessionId, userMessageId, error: toAppError(cause) })
  }
}

export function openFoldedTurn(context: TranscriptContext, userMessageId: string): Promise<void> {
  const fold = context.data.folded.get(userMessageId)
  if (!fold) return Promise.resolve()
  const newest = fold.openBefore === undefined && lastUserMessageId(context.data.messages) === userMessageId
  return readTurnOnce(context, userMessageId, () => (newest ? openNewestTurn(context, userMessageId) : openOlder(context, userMessageId, fold.openBefore)))
}
