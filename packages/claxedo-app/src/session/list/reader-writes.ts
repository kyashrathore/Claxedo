import type { Machine } from "@/lib/machine"
import { uuid } from "@/lib/uuid"
import { toAppError, type ReaderWrite, type Server, type SessionLocation, type SessionReader, type SessionRow } from "@/server"
import type { ListEvent, ListState } from "./model"
import { readerOf } from "./readers"

function settledThrough(row: SessionRow | undefined): number {
  return Math.max(row?.lastHumanTurnAt ?? 0, row?.lastTurn?.completedAt ?? 0)
}

function expected(held: SessionReader, row: SessionRow | undefined, write: ReaderWrite): SessionReader {
  if (write.kind === "seen") return { ...held, seenAt: Math.max(held.seenAt ?? 0, write.completedAt) }
  const { settledAt: _settledAt, ...active } = held
  return write.settled ? { ...active, settledAt: settledThrough(row) } : active
}

function sent(server: Server, ref: SessionLocation, write: ReaderWrite): Promise<SessionReader> {
  return write.kind === "seen" ? server.sessions.markSeen(ref, write.completedAt) : server.sessions.settle(ref, write.settled)
}

export async function writeReader(server: Server, list: Machine<ListState, ListEvent>, ref: SessionLocation, write: ReaderWrite): Promise<void> {
  const { sessionId } = ref
  const state = list.state()
  const entry = state.entries.get(sessionId)
  const writeId = uuid()
  list.send({ type: "readerWriteStarted", sessionId, writeId, reader: expected(readerOf(state, sessionId), entry?.kind === "tombstone" ? undefined : entry?.row, write) })
  try {
    list.send({ type: "readerWritten", sessionId, writeId, reader: await sent(server, ref, write), at: Date.now() })
  } catch (cause) {
    list.send({ type: "readerWriteFailed", sessionId, writeId })
    throw toAppError(cause)
  }
}
