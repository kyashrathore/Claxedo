import { isJsonRecord } from "../platform/runtime/lib/json"

export type SessionReaderState = { seenAt?: number; settledAt?: number }

/** `through` is the last activity the reader's row showed when it settled: `max(lastHumanTurnAt, lastTurn.completedAt)`. */
export type SessionReaderWrite = { seenThrough: number } | { settled: true; through: number } | { settled: false }

export type SessionReaderAction = "seen" | "settle"

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** The write a `seen` (`{ completedAt }`) or `settle` (`{ settled, through }`) body asks for; nothing for any other body. */
export function sessionReaderWrite(action: SessionReaderAction, body: unknown): SessionReaderWrite | undefined {
  if (!isJsonRecord(body)) return undefined
  if (action === "seen") {
    const completedAt = timestamp(body.completedAt)
    return completedAt ? { seenThrough: completedAt } : undefined
  }
  if (body.settled === false) return { settled: false }
  const through = timestamp(body.through)
  return body.settled === true && through !== undefined ? { settled: true, through } : undefined
}

export function sessionReaderState(seenAt: number | undefined, settledAt: number | undefined): SessionReaderState {
  return { ...(seenAt === undefined ? {} : { seenAt }), ...(settledAt === undefined ? {} : { settledAt }) }
}
