import { batch } from "solid-js"
import { toAppError, type TranscriptPage } from "@/server"
import { waitForIdle } from "@/lib/idle"
import type { TranscriptContext } from "./context"
import { lastUserMessageId, mergeWholeTurn } from "./conversation"
import { applyTranscriptEvent } from "./events"
import { isOptimisticMessage } from "./merge"

const IDLE_TIMEOUT_MS = 1000

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

function latestFolded(context: TranscriptContext): string | undefined {
  const userMessageId = lastUserMessageId(context.data.messages)
  return userMessageId !== undefined && context.data.folded.has(userMessageId) ? userMessageId : undefined
}

function readWhole(context: TranscriptContext, userMessageId: string, read: () => Promise<void>): Promise<void> {
  const pending = context.wholeTurnReads.get(userMessageId)
  if (pending) return pending
  const started = read().finally(() => context.wholeTurnReads.delete(userMessageId))
  context.wholeTurnReads.set(userMessageId, started)
  return started
}

function landLatest(context: TranscriptContext, userMessageId: string, page: TranscriptPage | undefined): void {
  const current = context.phase.state()
  if (current.kind !== "completing") return
  batch(() => {
    if (page) {
      mergeWholeTurn(context.setData, page)
      context.latestTurnRead.current = page
      adoptOlderCursor(context, page)
    }
    unfold(context, userMessageId)
    for (const event of current.held) applyTranscriptEvent(context, event)
    context.phase.send({ type: "latestLanded" })
  })
}

async function completeLatest(context: TranscriptContext, userMessageId: string): Promise<void> {
  context.phase.send({ type: "latestStarted" })
  if (context.phase.state().kind !== "completing") return
  try {
    landLatest(context, userMessageId, await context.server.sessions.wholeTurn(context.ref))
  } catch (cause) {
    console.error("The latest turn could not be read in full", { sessionId: context.ref.sessionId, error: toAppError(cause) })
    landLatest(context, userMessageId, undefined)
  }
}

export function completeLatestTurn(context: TranscriptContext): Promise<void> {
  const userMessageId = latestFolded(context)
  return userMessageId === undefined ? Promise.resolve() : readWhole(context, userMessageId, () => completeLatest(context, userMessageId))
}

export function completeLatestTurnWhenIdle(context: TranscriptContext): void {
  if (latestFolded(context) === undefined) return
  context.idleCompletion.current?.cancel()
  const wait = waitForIdle(IDLE_TIMEOUT_MS)
  context.idleCompletion.current = wait
  void wait.done.then((ready) => {
    if (context.idleCompletion.current === wait) context.idleCompletion.current = undefined
    if (ready) void completeLatestTurn(context)
  })
}

export function readFoldedTurn(context: TranscriptContext, userMessageId: string): Promise<void> {
  const fold = context.data.folded.get(userMessageId)
  if (!fold) return Promise.resolve()
  const { wholeBefore } = fold
  if (wholeBefore === undefined) return completeLatestTurn(context)
  return readWhole(context, userMessageId, async () => {
    try {
      const page = await context.server.sessions.wholeTurn(context.ref, wholeBefore)
      batch(() => {
        mergeWholeTurn(context.setData, page)
        unfold(context, userMessageId)
      })
    } catch (cause) {
      console.error("A folded turn could not be read in full", { sessionId: context.ref.sessionId, userMessageId, error: toAppError(cause) })
    }
  })
}
