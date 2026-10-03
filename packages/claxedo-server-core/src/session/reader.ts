import { isJsonRecord } from "../platform/runtime/lib/json"

/** One reader's marks on one session: the last turn end it has seen, and the activity it settled the session through. */
export type SessionReaderState = { seenAt?: number; settledAt?: number }

/** `seenThrough` raises the reader's seen mark to that turn end; `settled` settles the session or returns it to active. */
export type SessionReaderWrite = { seenThrough: number } | { settled: boolean }

export type SessionReaderAction = "seen" | "settle"

/** The write a `seen` (`{ completedAt }`) or `settle` (`{ settled }`) body asks for; nothing for any other body. */
export function sessionReaderWrite(action: SessionReaderAction, body: unknown): SessionReaderWrite | undefined {
  if (!isJsonRecord(body)) return undefined
  if (action === "settle") return typeof body.settled === "boolean" ? { settled: body.settled } : undefined
  const completedAt = body.completedAt
  return typeof completedAt === "number" && Number.isSafeInteger(completedAt) && completedAt > 0 ? { seenThrough: completedAt } : undefined
}

export function sessionReaderState(seenAt: number | undefined, settledAt: number | undefined): SessionReaderState {
  return { ...(seenAt === undefined ? {} : { seenAt }), ...(settledAt === undefined ? {} : { settledAt }) }
}
