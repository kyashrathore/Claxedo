import { unreachable } from "@/lib/machine"
import type { ProjectId } from "@/server"
import { hasMorePages, type FetchedWindow, type ListData, type ListEvent, type ListState, type MorePhase, type RereadMode, type ServerListEvent } from "./model"
import {
  closeSession,
  confirmCreate,
  extendWindow,
  failCreate,
  failSend,
  openSession,
  refreshWindow,
  replaceWindow,
  startCreate,
  startSend,
  tombstoneRow,
  upsertRow,
} from "./rows"
import { pageStatusesRead, statusChanged, statusRead } from "./statuses"

type More = ReadonlyMap<ProjectId, MorePhase>

const NO_MORE: More = new Map()

function data(state: ListState): ListData {
  return {
    entries: state.entries,
    statuses: state.statuses,
    open: state.open,
    windows: state.windows,
    failures: state.failures,
  }
}

function withData(state: ListState, next: ListData): ListState {
  return next === state ? state : { ...state, ...next }
}

function applyServerEvent<S extends ListData>(state: S, event: ServerListEvent): S {
  switch (event.type) {
    case "sessionUpserted":
      return upsertRow(state, event.row)
    case "sessionRemoved":
      return tombstoneRow(state, event.ref, event.at)
    case "statusChanged":
      return statusChanged(state, event.ref, event.status, event.at)
    default:
      return unreachable(event)
  }
}

function withPhase(more: More, projectId: ProjectId, phase: MorePhase | undefined): More {
  const next = new Map(more)
  if (phase) next.set(projectId, phase)
  else next.delete(projectId)
  return next
}

function serverEvent(state: ListState, event: ServerListEvent): ListState {
  if (state.kind === "fetching" || state.kind === "rereading") return { ...state, held: [...state.held, event] }
  if (state.kind === "live") {
    const projectId = event.type === "sessionUpserted" ? event.row.ref.projectId : event.ref.projectId
    const phase = state.more.get(projectId)
    if (phase?.kind === "loading") return { ...state, more: withPhase(state.more, projectId, { kind: "loading", held: [...phase.held, event] }) }
  }
  return withData(state, applyServerEvent(state, event))
}

const WINDOWING: Record<"extend" | RereadMode, (data: ListData, window: FetchedWindow) => ListData> = {
  extend: extendWindow,
  replace: replaceWindow,
  refresh: refreshWindow,
}

function live(base: ListData, window: FetchedWindow, held: readonly ServerListEvent[], mode: "extend" | RereadMode, more: More): ListState {
  const windowed = pageStatusesRead(WINDOWING[mode](base, window), window)
  const replayed = held.reduce(applyServerEvent, windowed)
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
      if (state.kind !== "live" || state.more.get(event.projectId)?.kind === "loading" || !hasMorePages(state.windows, event.projectId)) return state
      return { ...state, more: withPhase(state.more, event.projectId, { kind: "loading", held: [] }) }
    case "moreFetched": {
      const phase = state.kind === "live" ? state.more.get(event.projectId) : undefined
      if (state.kind !== "live" || phase?.kind !== "loading") return state
      return live(data(state), event.window, phase.held, "extend", withPhase(state.more, event.projectId, undefined))
    }
    case "moreFailed":
      if (state.kind !== "live" || state.more.get(event.projectId)?.kind !== "loading") return state
      return { ...state, more: withPhase(state.more, event.projectId, { kind: "failed", error: event.error }) }
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

export function transition(state: ListState, event: ListEvent): ListState {
  switch (event.type) {
    case "sessionUpserted":
    case "sessionRemoved":
    case "statusChanged":
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
      return withData(state, upsertRow(state, event.row))
    case "statusRead":
      return withData(state, statusRead(state, event.ref, event.status, event.sentAt))
    case "sessionOpened":
      return withData(state, openSession(state, event.sessionId))
    case "sessionClosed":
      return withData(state, closeSession(state, event.sessionId))
    case "createStarted":
      return withData(state, startCreate(state, event.clientRequestId, event.row))
    case "createConfirmed":
      return withData(state, confirmCreate(state, event.clientRequestId, event.row))
    case "createFailed":
      return withData(state, failCreate(state, event.clientRequestId))
    case "sendStarted":
      return withData(state, startSend(state, event.sessionId, event.clientRequestId, event.at))
    case "sendFailed":
      return withData(state, failSend(state, event.sessionId, event.clientRequestId))
    default:
      return unreachable(event)
  }
}
