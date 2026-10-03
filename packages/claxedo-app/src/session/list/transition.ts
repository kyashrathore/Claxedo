import { unreachable } from "@/lib/machine"
import { ACTIVITY_WINDOW, canReadPage, type FetchedWindow, type ListData, type ListEvent, type ListState, type MorePhase, type RereadMode, type ServerListEvent, type WindowKey } from "./model"
import {
  closeSession,
  confirmCreate,
  extendWindow,
  failCreate,
  failSend,
  openSession,
  refreshWindow,
  replaceWindow,
  rowsRead,
  startCreate,
  startSend,
  tombstoneRow,
  turnEnded,
  upsertRow,
} from "./rows"
import { backgroundWorkChanged, backgroundWorkRead, pageStatusesRead, statusChanged, statusRead } from "./statuses"
import { confirmReaderWrite, failReaderWrite, pageReadersRead, readerChanged, startReaderWrite } from "./readers"

type More = ReadonlyMap<WindowKey, MorePhase>

const NO_MORE: More = new Map()

function data(state: ListState): ListData {
  return {
    entries: state.entries,
    statuses: state.statuses,
    backgroundWork: state.backgroundWork,
    readers: state.readers,
    open: state.open,
    windows: state.windows,
    failures: state.failures,
    degraded: state.degraded,
  }
}

function withData(state: ListState, next: ListData): ListState {
  return next === state ? state : { ...state, ...next }
}

function applyListEvent<S extends ListData>(state: S, event: ServerListEvent): S {
  switch (event.type) {
    case "sessionUpserted":
      return upsertRow(state, event.row)
    case "sessionRemoved":
      return tombstoneRow(state, event.ref, event.at)
    case "statusChanged": {
      const next = statusChanged(state, event.ref, event.status, event.at, event.waitingOnUser)
      return event.lastTurn ? turnEnded(next, event.ref, event.lastTurn) : next
    }
    case "backgroundWorkChanged":
      return backgroundWorkChanged(state, event.ref, event.work, event.at)
    case "readerChanged":
      return readerChanged(state, event.ref, event.reader, event.at)
    case "turnEndRowRead":
      return turnEndRowRead(state, event)
    default:
      return unreachable(event)
  }
}

function turnEndRowRead<S extends ListData>(state: S, event: Extract<ServerListEvent, { type: "turnEndRowRead" }>): S {
  const admitted = rowsRead(state, event.window)
  const entry = admitted.entries.get(event.ref.sessionId)
  if (entry?.kind !== "confirmed" || entry.row.parentSessionId !== undefined) return state
  return turnEnded(pageReadersRead(pageStatusesRead(admitted, event.window), event.window), event.ref, event.lastTurn)
}

function withPhase(more: More, windowKey: WindowKey, phase: MorePhase | undefined): More {
  const next = new Map(more)
  if (phase) next.set(windowKey, phase)
  else next.delete(windowKey)
  return next
}

function serverEvent(state: ListState, event: ServerListEvent): ListState {
  if (state.kind === "fetching" || state.kind === "rereading") return { ...state, held: [...state.held, event] }
  if (state.kind === "live") {
    const projectId = event.type === "sessionUpserted" ? event.row.ref.projectId : event.ref.projectId
    const holder = [ACTIVITY_WINDOW, projectId].find((windowKey) => state.more.get(windowKey)?.kind === "loading")
    const phase = holder === undefined ? undefined : state.more.get(holder)
    if (holder !== undefined && phase?.kind === "loading") return { ...state, more: withPhase(state.more, holder, { kind: "loading", held: [...phase.held, event] }) }
  }
  return withData(state, applyListEvent(state, event))
}

const WINDOWING: Record<"extend" | RereadMode, (data: ListData, window: FetchedWindow) => ListData> = {
  extend: extendWindow,
  replace: replaceWindow,
  refresh: refreshWindow,
}

function live(base: ListData, window: FetchedWindow, held: readonly ServerListEvent[], mode: "extend" | RereadMode, more: More): ListState {
  const windowed = pageReadersRead(pageStatusesRead(WINDOWING[mode](base, window), window), window)
  const replayed = held.reduce(applyListEvent, windowed)
  return { ...replayed, kind: "live", more }
}

function fetchEvent(state: ListState, event: ListEvent): ListState | undefined {
  switch (event.type) {
    case "fetchStarted":
      return state.kind === "subscribing" ? { ...data(state), kind: "fetching", held: [] } : state
    case "fetched":
      return state.kind === "fetching" ? live(data(state), event.window, state.held, "extend", NO_MORE) : state
    case "fetchFailed":
      return state.kind === "fetching" ? { ...data(state), kind: "failed", error: event.error } : state
    case "moreStarted":
      if (state.kind !== "live" || state.more.get(event.windowKey)?.kind === "loading" || !canReadPage(state.windows, event.windowKey)) return state
      return { ...state, more: withPhase(state.more, event.windowKey, { kind: "loading", held: [] }) }
    case "moreFetched": {
      const phase = state.kind === "live" ? state.more.get(event.windowKey) : undefined
      if (state.kind !== "live" || phase?.kind !== "loading") return state
      return live(data(state), event.window, phase.held, "extend", withPhase(state.more, event.windowKey, undefined))
    }
    case "moreFailed":
      if (state.kind !== "live" || state.more.get(event.windowKey)?.kind !== "loading") return state
      return { ...state, more: withPhase(state.more, event.windowKey, { kind: "failed", error: event.error }) }
    case "rereadStarted":
      return state.kind === "live" || state.kind === "failed" ? { ...data(state), kind: "rereading", held: [] } : state
    case "rereadFetched":
      return state.kind === "rereading" ? live(data(state), event.window, state.held, event.mode, NO_MORE) : state
    case "rereadFailed":
      return state.kind === "rereading" ? { ...data(state), kind: "failed", error: event.error } : state
    default:
      return undefined
  }
}

function sessionRead(state: ListState, event: Extract<ListEvent, { type: "rowRead" | "statusRead" | "backgroundWorkRead" }>): ListData {
  switch (event.type) {
    case "rowRead":
      return upsertRow(state, event.row)
    case "statusRead":
      return statusRead(state, event.ref, event.status, event.sentAt)
    case "backgroundWorkRead":
      return backgroundWorkRead(state, event.ref, event.work, event.sentAt)
    default:
      return unreachable(event)
  }
}

type OwnWrite = Extract<ListEvent, { type: "createStarted" | "createConfirmed" | "createFailed" | "sendStarted" | "sendFailed" | "readerWriteStarted" | "readerWritten" | "readerWriteFailed" }>

function ownWrite(state: ListState, event: OwnWrite): ListData {
  switch (event.type) {
    case "createStarted":
      return startCreate(state, event.clientRequestId, event.row)
    case "createConfirmed":
      return confirmCreate(state, event.clientRequestId, event.row)
    case "createFailed":
      return failCreate(state, event.clientRequestId)
    case "sendStarted":
      return startSend(state, event.sessionId, event.clientRequestId, event.at)
    case "sendFailed":
      return failSend(state, event.sessionId, event.clientRequestId)
    case "readerWriteStarted":
      return startReaderWrite(state, event.sessionId, event.writeId, event.reader)
    case "readerWritten":
      return confirmReaderWrite(state, event.sessionId, event.writeId, event.reader, event.at)
    case "readerWriteFailed":
      return failReaderWrite(state, event.sessionId, event.writeId)
    default:
      return unreachable(event)
  }
}

export function listTransition(state: ListState, event: ListEvent): ListState {
  switch (event.type) {
    case "sessionUpserted":
    case "sessionRemoved":
    case "statusChanged":
    case "backgroundWorkChanged":
    case "readerChanged":
    case "turnEndRowRead":
      return serverEvent(state, event)
    case "fetchStarted":
    case "fetched":
    case "fetchFailed":
    case "moreStarted":
    case "moreFetched":
    case "moreFailed":
    case "rereadStarted":
    case "rereadFetched":
    case "rereadFailed":
      return fetchEvent(state, event) ?? state
    case "rowRead":
    case "statusRead":
    case "backgroundWorkRead":
      return withData(state, sessionRead(state, event))
    case "sessionOpened":
      return withData(state, openSession(state, event.sessionId))
    case "sessionClosed":
      return withData(state, closeSession(state, event.sessionId))
    case "createStarted":
    case "createConfirmed":
    case "createFailed":
    case "sendStarted":
    case "sendFailed":
    case "readerWriteStarted":
    case "readerWritten":
    case "readerWriteFailed":
      return withData(state, ownWrite(state, event))
    default:
      return unreachable(event)
  }
}
