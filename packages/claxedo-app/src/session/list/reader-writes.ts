import type { Machine } from "@/lib/machine"
import { uuid } from "@/lib/uuid"
import { settledThrough, toAppError, type ReaderWrite, type Server, type SessionLocation, type SessionReader } from "@/server"
import type { ListEvent, ListState } from "./model"
import { readerOf } from "./readers"

export type ListReaderWrite = { readonly kind: "seen"; readonly completedAt: number } | { readonly kind: "settle"; readonly settled: boolean }

function serverWrite(state: ListState, ref: SessionLocation, write: ListReaderWrite): ReaderWrite {
  if (write.kind === "seen") return write
  if (!write.settled) return { kind: "settle", settled: false }
  const entry = state.entries.get(ref.sessionId)
  return { kind: "settle", settled: true, through: settledThrough(entry?.kind === "tombstone" ? undefined : entry?.row) }
}

function expected(held: SessionReader, write: ReaderWrite): SessionReader {
  if (write.kind === "seen") return { ...held, seenAt: Math.max(held.seenAt ?? 0, write.completedAt) }
  const { settledAt: _settledAt, ...active } = held
  return write.settled ? { ...active, settledAt: write.through } : active
}

function sent(server: Server, ref: SessionLocation, write: ReaderWrite): Promise<SessionReader> {
  if (write.kind === "seen") return server.sessions.markSeen(ref, write.completedAt)
  return server.sessions.settle(ref, write.settled ? { settled: true, through: write.through } : { settled: false })
}

export async function writeReader(server: Server, list: Machine<ListState, ListEvent>, ref: SessionLocation, request: ListReaderWrite): Promise<void> {
  const { sessionId } = ref
  const state = list.state()
  const write = serverWrite(state, ref, request)
  const writeId = uuid()
  list.send({ type: "readerWriteStarted", sessionId, writeId, reader: expected(readerOf(state, sessionId), write) })
  try {
    list.send({ type: "readerWritten", sessionId, writeId, reader: await sent(server, ref, write), at: Date.now() })
  } catch (cause) {
    list.send({ type: "readerWriteFailed", sessionId, writeId })
    throw toAppError(cause)
  }
}
