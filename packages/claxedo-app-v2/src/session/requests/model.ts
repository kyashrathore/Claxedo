import { unreachable } from "@/lib/machine"
import type { AgentRequest, AppError, RequestId, SessionRef } from "@/server"
import type { RequestState } from "@/session"

export type RequestEntry = {
  readonly ref: SessionRef
  readonly request: AgentRequest
  readonly state: RequestState
  readonly at: number
}

export type RequestsData = {
  readonly entries: ReadonlyMap<RequestId, RequestEntry>
  readonly closedAt: ReadonlyMap<RequestId, number>
}

export type RequestMachineEvent =
  | { readonly type: "replyStarted" }
  | { readonly type: "replyAccepted" }
  | { readonly type: "replyRejected"; readonly error: AppError }

export type RequestsEvent =
  | { readonly type: "opened"; readonly ref: SessionRef; readonly request: AgentRequest; readonly at: number }
  | { readonly type: "closed"; readonly requestId: RequestId; readonly at: number }
  | { readonly type: "read"; readonly ref: SessionRef; readonly requests: readonly AgentRequest[]; readonly sentAt: number }
  | ({ readonly requestId: RequestId } & RequestMachineEvent)

export const OPEN: RequestState = { kind: "open" }
export const ANSWERING: RequestState = { kind: "answering" }
export const ANSWERED: RequestState = { kind: "answered" }
export const EXPIRED: RequestState = { kind: "expired" }

export const initialRequestsData: RequestsData = { entries: new Map(), closedAt: new Map() }

export const CLOSED_MEMORY = 64

export const isOpenRequest = (state: RequestState): boolean =>
  state.kind === "open" || state.kind === "answering" || state.kind === "failed"

export function requestTransition(state: RequestState, event: RequestMachineEvent): RequestState {
  switch (event.type) {
    case "replyStarted":
      return state.kind === "open" || state.kind === "failed" ? ANSWERING : state
    case "replyAccepted":
      return state.kind === "answering" ? ANSWERED : state
    case "replyRejected":
      return state.kind === "answering" ? { kind: "failed", error: event.error } : state
    default:
      return unreachable(event)
  }
}

function withEntries(data: RequestsData, entries: ReadonlyMap<RequestId, RequestEntry>): RequestsData {
  return { ...data, entries }
}

function rememberClosed(data: RequestsData, requestId: RequestId, at: number): ReadonlyMap<RequestId, number> {
  const closedAt = new Map(data.closedAt)
  closedAt.delete(requestId)
  closedAt.set(requestId, at)
  while (closedAt.size > CLOSED_MEMORY) closedAt.delete(closedAt.keys().next().value as RequestId)
  return closedAt
}

function opened(data: RequestsData, ref: SessionRef, request: AgentRequest, at: number): RequestsData {
  const current = data.entries.get(request.id)
  const entries = new Map(data.entries)
  entries.set(request.id, { ref, request, at, state: current?.state ?? OPEN })
  return withEntries(data, entries)
}

function closed(data: RequestsData, requestId: RequestId, at: number): RequestsData {
  const entries = new Map(data.entries)
  entries.delete(requestId)
  return { entries, closedAt: rememberClosed(data, requestId, at) }
}

function read(data: RequestsData, ref: SessionRef, requests: readonly AgentRequest[], sentAt: number): RequestsData {
  const listed = new Set(requests.map((request) => request.id))
  const entries = new Map(data.entries)
  for (const [id, entry] of data.entries) {
    if (entry.ref.sessionId !== ref.sessionId || listed.has(id) || entry.at >= sentAt) continue
    entries.delete(id)
  }
  for (const request of requests) {
    const current = entries.get(request.id)
    if (current) continue
    if ((data.closedAt.get(request.id) ?? Number.NEGATIVE_INFINITY) >= sentAt) continue
    entries.set(request.id, { ref, request, at: sentAt, state: OPEN })
  }
  return withEntries(data, entries)
}

function replied(data: RequestsData, requestId: RequestId, event: RequestMachineEvent): RequestsData {
  const current = data.entries.get(requestId)
  if (!current) return data
  const state = requestTransition(current.state, event)
  if (state === current.state) return data
  const entries = new Map(data.entries)
  entries.set(requestId, { ...current, state })
  return withEntries(data, entries)
}

export function applyRequestsEvent(data: RequestsData, event: RequestsEvent): RequestsData {
  switch (event.type) {
    case "opened":
      return opened(data, event.ref, event.request, event.at)
    case "closed":
      return closed(data, event.requestId, event.at)
    case "read":
      return read(data, event.ref, event.requests, event.sentAt)
    case "replyStarted":
    case "replyAccepted":
    case "replyRejected":
      return replied(data, event.requestId, event)
    default:
      return unreachable(event)
  }
}
