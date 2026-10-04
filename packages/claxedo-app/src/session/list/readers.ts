import type { SessionId, SessionLocation, SessionReader } from "@/server"
import type { FetchedWindow, ListData, ReaderEntry } from "./model"
import { readIsStale } from "./statuses"

const NO_READER: SessionReader = {}

function laterSeen(held: number | undefined, incoming: number | undefined): number | undefined {
  if (held === undefined) return incoming
  return incoming === undefined ? held : Math.max(held, incoming)
}

function confirmed(held: SessionReader, incoming: SessionReader): SessionReader {
  const seenAt = laterSeen(held.seenAt, incoming.seenAt)
  return { ...(seenAt === undefined ? {} : { seenAt }), ...(incoming.settledAt === undefined ? {} : { settledAt: incoming.settledAt }) }
}

function withReader<S extends ListData>(data: S, sessionId: SessionId, entry: ReaderEntry): S {
  const readers = new Map(data.readers)
  readers.set(sessionId, entry)
  return { ...data, readers }
}

export function shownReader(entry: ReaderEntry | undefined): SessionReader {
  return entry?.pending?.reader ?? entry?.reader ?? NO_READER
}

export function readerOf(data: Pick<ListData, "readers">, sessionId: SessionId): SessionReader {
  return shownReader(data.readers.get(sessionId))
}

export function pageReadersRead<S extends ListData>(data: S, window: FetchedWindow): S {
  let readers: Map<SessionId, ReaderEntry> | undefined
  for (const page of window.pages) {
    for (const [sessionId, reader] of page.readers) {
      const held = data.readers.get(sessionId)
      if (readIsStale(held, window.sentAt)) continue
      readers ??= new Map(data.readers)
      readers.set(sessionId, { ...held, reader: confirmed(held?.reader ?? NO_READER, reader), at: window.sentAt, source: "read" })
    }
  }
  return readers ? { ...data, readers } : data
}

export function readerChanged<S extends ListData>(data: S, ref: SessionLocation, reader: SessionReader, at: number): S {
  const held = data.readers.get(ref.sessionId)
  return withReader(data, ref.sessionId, { ...held, reader: confirmed(held?.reader ?? NO_READER, reader), at, source: "event" })
}

export function startReaderWrite<S extends ListData>(data: S, sessionId: SessionId, writeId: string, reader: SessionReader): S {
  const held = data.readers.get(sessionId)
  return withReader(data, sessionId, { reader: held?.reader ?? NO_READER, at: held?.at ?? 0, source: held?.source ?? "read", pending: { writeId, reader } })
}

export function confirmReaderWrite<S extends ListData>(data: S, sessionId: SessionId, writeId: string, reader: SessionReader, at: number): S {
  const held = data.readers.get(sessionId)
  const base = held?.reader ?? NO_READER
  if (held?.pending && held.pending.writeId !== writeId) {
    const seenAt = laterSeen(base.seenAt, reader.seenAt)
    return withReader(data, sessionId, { ...held, reader: { ...base, ...(seenAt === undefined ? {} : { seenAt }) } })
  }
  return withReader(data, sessionId, { reader: confirmed(base, reader), at, source: "event" })
}

export function failReaderWrite<S extends ListData>(data: S, sessionId: SessionId, writeId: string): S {
  const held = data.readers.get(sessionId)
  if (held?.pending?.writeId !== writeId) return data
  const { pending: _pending, ...settled } = held
  return withReader(data, sessionId, settled)
}
