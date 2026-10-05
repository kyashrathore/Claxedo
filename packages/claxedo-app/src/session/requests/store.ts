import { createMemo, createSignal, type Accessor } from "solid-js"
import { toAppError, type AgentRequest, type AgentRequestReply, type AppError, type RequestId, type Server, type ServerEvent, type SessionId, type SessionLocation } from "@/server"
import type { RequestState } from "@/session"
import { permissionDecided } from "./permission-decided"
import { EXPIRED, applyRequestsEvent, initialRequestsData, isOpenRequest, readErrorOf, type RequestsData, type RequestsEvent } from "./model"

export type RequestsInternal = {
  readonly openBySession: Accessor<ReadonlyMap<SessionId, readonly AgentRequest[]>>
  readonly openFor: (sessionId: SessionId) => readonly AgentRequest[]
  readonly stateOf: (requestId: RequestId) => RequestState
  readonly apply: (event: ServerEvent) => void
  readonly read: (ref: SessionLocation, requests: readonly AgentRequest[], sentAt: number) => void
  readonly readFailed: (ref: SessionLocation, error: AppError, sentAt: number) => void
  readonly readErrorFor: (sessionId: SessionId) => AppError | undefined
  readonly reply: (ref: SessionLocation, requestId: RequestId, reply: AgentRequestReply) => Promise<void>
}

const NO_REQUESTS: readonly AgentRequest[] = Object.freeze([])

function openRequestsBySession(data: RequestsData): ReadonlyMap<SessionId, readonly AgentRequest[]> {
  const open = new Map<SessionId, AgentRequest[]>()
  for (const entry of data.entries.values()) {
    if (!isOpenRequest(entry.state)) continue
    const list = open.get(entry.ref.sessionId) ?? []
    list.push(entry.request)
    open.set(entry.ref.sessionId, list)
  }
  return open
}

function requestsEventOf(event: ServerEvent): RequestsEvent | undefined {
  if (event.type === "requestOpened") return { type: "opened", ref: event.ref, request: event.request, at: Date.now() }
  if (event.type === "requestClosed") return { type: "closed", requestId: event.requestId, at: Date.now() }
  return undefined
}

async function sendReply(
  server: Server,
  send: (event: RequestsEvent) => void,
  ref: SessionLocation,
  requestId: RequestId,
  answer: AgentRequestReply,
  request: AgentRequest | undefined,
): Promise<void> {
  send({ type: "replyStarted", requestId })
  try {
    await server.sessions.reply(ref, requestId, answer)
    send({ type: "replyAccepted", requestId })
    const decided = permissionDecided(request, answer)
    if (decided) server.telemetry.record(decided)
  } catch (cause) {
    send({ type: "replyRejected", requestId, error: toAppError(cause) })
  }
}

export function createRequests(server: Server): RequestsInternal {
  const [data, setData] = createSignal(initialRequestsData)
  const send = (event: RequestsEvent) => setData((current) => applyRequestsEvent(current, event))
  const openBySession = createMemo(() => openRequestsBySession(data()))
  const read = (ref: SessionLocation, requests: readonly AgentRequest[], sentAt: number) => send({ type: "read", ref, requests, sentAt })
  return {
    openBySession,
    openFor: (sessionId) => openBySession().get(sessionId) ?? NO_REQUESTS,
    stateOf: (requestId) => data().entries.get(requestId)?.state ?? EXPIRED,
    apply: (event) => {
      const next = requestsEventOf(event)
      if (next) send(next)
    },
    read,
    readFailed: (ref, error, sentAt) => send({ type: "readFailed", ref, error, sentAt }),
    readErrorFor: (sessionId) => readErrorOf(data(), sessionId),
    reply: (ref, requestId, answer) => sendReply(server, send, ref, requestId, answer, data().entries.get(requestId)?.request),
  }
}
