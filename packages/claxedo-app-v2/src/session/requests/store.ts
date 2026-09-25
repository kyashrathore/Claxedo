import { createMemo, createSignal, type Accessor } from "solid-js"
import type { AgentRequest, AgentRequestReply, AppError, RequestId, Server, ServerEvent, SessionId, SessionRef } from "@/server"
import type { RequestState } from "@/session"
import { toAppError } from "./app-error"
import { EXPIRED, applyRequestsEvent, initialRequestsData, isOpenRequest, readErrorOf, type RequestsData, type RequestsEvent } from "./model"

export type RequestsRead = { readonly ref: SessionRef; readonly requests: readonly AgentRequest[] }

export type RequestsInternal = {
  readonly openBySession: Accessor<ReadonlyMap<SessionId, readonly AgentRequest[]>>
  readonly openFor: (sessionId: SessionId) => readonly AgentRequest[]
  readonly stateOf: (requestId: RequestId) => RequestState
  readonly apply: (event: ServerEvent) => void
  readonly read: (ref: SessionRef, requests: readonly AgentRequest[], sentAt: number) => void
  readonly readFailed: (ref: SessionRef, error: AppError, sentAt: number) => void
  readonly readErrorFor: (sessionId: SessionId) => AppError | undefined
  readonly applyReads: (reads: readonly RequestsRead[], sentAt: number) => void
  readonly reply: (ref: SessionRef, requestId: RequestId, reply: AgentRequestReply) => Promise<void>
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
  ref: SessionRef,
  requestId: RequestId,
  answer: AgentRequestReply,
): Promise<void> {
  send({ type: "replyStarted", requestId })
  try {
    await server.sessions.reply(ref, requestId, answer)
    send({ type: "replyAccepted", requestId })
  } catch (cause) {
    send({ type: "replyRejected", requestId, error: toAppError(cause) })
  }
}

export function createRequests(server: Server): RequestsInternal {
  const [data, setData] = createSignal(initialRequestsData)
  const send = (event: RequestsEvent) => setData((current) => applyRequestsEvent(current, event))
  const openBySession = createMemo(() => openRequestsBySession(data()))
  const read = (ref: SessionRef, requests: readonly AgentRequest[], sentAt: number) => send({ type: "read", ref, requests, sentAt })
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
    applyReads: (reads, sentAt) => {
      for (const item of reads) read(item.ref, item.requests, sentAt)
    },
    reply: (ref, requestId, answer) => sendReply(server, send, ref, requestId, answer),
  }
}
