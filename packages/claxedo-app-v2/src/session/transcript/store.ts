import { createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { machine, unreachable } from "@/lib/machine"
import type { PromptInput, Server, ServerEvent, SessionRef, SessionSnapshot, TranscriptMessage } from "@/server"
import type { SessionLoadState, SessionView } from "@/session"
import type { TranscriptConversation } from "@/transcript"
import type { SessionListInternal } from "../list"
import { toAppError, type RequestsInternal } from "../requests"
import {
  NO_PARTS,
  appendDelta,
  dropQueuedStubs,
  lastUserMessageId,
  prependPage,
  removeMessage,
  removePart,
  replaceLatest,
  upsertMessage,
  upsertPart,
} from "./conversation"
import { createDeltaBuffer } from "./deltas"
import { createSessionGoal } from "./goal"
import { isPendingMessage, isPresentationMessage, searchById } from "./merge"
import {
  OLDER_IDLE,
  emptyTranscript,
  initialPhase,
  isReading,
  isTranscriptEvent,
  olderTransition,
  phaseTransition,
  type SessionPhase,
  type TranscriptEvent,
} from "./model"
import { createQueue } from "./queue"

export type TranscriptDeps = {
  readonly list: SessionListInternal
  readonly requests: RequestsInternal
}

export type SessionTranscript = SessionView & {
  readonly apply: (event: ServerEvent) => void
  readonly gap: () => void
  readonly dispose: () => void
}

const LOADING: SessionLoadState = { kind: "loading" }
const READY: SessionLoadState = { kind: "ready" }
const MISSING: SessionLoadState = { kind: "missing" }

function loadState(phase: SessionPhase): SessionLoadState {
  switch (phase.kind) {
    case "loading":
      return LOADING
    case "ready":
    case "rereading":
      return READY
    case "missing":
      return MISSING
    case "failed":
      return { kind: "failed", message: phase.error.message, error: phase.error }
    default:
      return unreachable(phase)
  }
}

export function createSessionTranscript(server: Server, ref: SessionRef, deps: TranscriptDeps): SessionTranscript {
  const [data, setData] = createStore(emptyTranscript())
  const phase = machine(initialPhase, phaseTransition)
  const older = machine(OLDER_IDLE, olderTransition)
  const [olderCursor, setOlderCursor] = createSignal<string>()
  const deltas = createDeltaBuffer((messageId, partId, field, text) => appendDelta(setData, data, messageId, partId, field, text))
  const queue = createQueue(server, ref, (items) => dropQueuedStubs(setData, data, items))
  const goal = createSessionGoal(server, ref)
  const state = createMemo(() => loadState(phase.state()))
  const lastUserId = createMemo(() => lastUserMessageId(data.messages))

  function upsertInfo(info: TranscriptMessage): void {
    if (!isPresentationMessage(info)) return
    upsertMessage(setData, info)
    if (info.role === "user") void queue.reread()
  }

  function applyNow(event: TranscriptEvent): void {
    switch (event.type) {
      case "messageUpserted":
        return upsertInfo(event.message)
      case "messageRemoved":
        return removeMessage(setData, event.messageId)
      case "partUpserted":
        return upsertPart(setData, event.part)
      case "partRemoved":
        return removePart(setData, event.messageId, event.partId)
      case "todosChanged":
        return setData("todos", [...event.todos])
      case "diffChanged":
        return setData("diff", [...event.diff])
      case "goalChanged":
        return goal.changed(event.goal)
      default:
        return unreachable(event)
    }
  }

  function apply(event: ServerEvent): void {
    if (event.type === "partDelta") return deltas.add(event.messageId, event.partId, event.field, event.delta)
    if (event.type === "statusChanged") return void queue.reread()
    if (!isTranscriptEvent(event)) return
    if (isReading(phase.state())) return phase.send({ type: "held", event })
    applyNow(event)
  }

  function land(snapshot: SessionSnapshot, sentAt: number): void {
    const current = phase.state()
    const held = isReading(current) ? current.held : []
    deltas.drop()
    deps.list.readRow(snapshot.row)
    deps.list.readStatus(ref, snapshot.status, sentAt)
    deps.requests.read(ref, snapshot.requests, sentAt)
    replaceLatest(setData, snapshot.transcript)
    const first = snapshot.transcript.entries[0]?.info.id
    const hasOlderLoaded = first !== undefined && data.messages.some((message) => !isPendingMessage(message) && message.id < first)
    if (!hasOlderLoaded) setOlderCursor(snapshot.transcript.olderCursor)
    setData("todos", [...snapshot.todos])
    setData("diff", [...snapshot.diff])
    goal.read(snapshot.goal)
    for (const event of held) applyNow(event)
    phase.send({ type: "readLanded" })
  }

  async function readSnapshot(): Promise<void> {
    if (isReading(phase.state())) return
    phase.send({ type: "readStarted" })
    const sentAt = Date.now()
    try {
      land(await server.sessions.snapshot(ref), sentAt)
    } catch (cause) {
      const error = toAppError(cause)
      phase.send(error.class === "not_found" ? { type: "readMissing" } : { type: "readFailed", error })
    }
  }

  async function loadOlder(): Promise<void> {
    const cursor = olderCursor()
    if (cursor === undefined || older.state().kind === "loading") return
    older.send({ type: "olderStarted" })
    try {
      const page = await server.sessions.older(ref, cursor)
      prependPage(setData, page)
      setOlderCursor(page.olderCursor)
      older.send({ type: "olderLanded" })
    } catch (cause) {
      older.send({ type: "olderFailed", error: toAppError(cause) })
    }
  }

  async function send(input: PromptInput): Promise<void> {
    const messageId = input.messageId ?? server.sessions.newMessageId()
    const at = Date.now()
    upsertMessage(setData, { origin: "optimistic", id: messageId, role: "user", sessionID: ref.sessionId, time: { created: at } })
    deps.list.sendStarted(ref.sessionId, input.clientRequestId, at)
    try {
      await server.sessions.prompt(ref, { ...input, messageId })
    } catch (cause) {
      removeMessage(setData, messageId)
      deps.list.sendFailed(ref.sessionId, input.clientRequestId)
      throw toAppError(cause)
    }
    void queue.reread()
  }

  async function stop(): Promise<void> {
    try {
      await server.sessions.stop(ref)
    } catch (cause) {
      throw toAppError(cause)
    }
  }

  function isPending(messageId: string): boolean {
    const { found, index } = searchById(data.messages, messageId)
    return found && isPendingMessage(data.messages[index])
  }

  void readSnapshot()
  void queue.reread()

  return {
    ref,
    state,
    row: () => deps.list.rowOf(ref.sessionId),
    status: () => deps.list.statusOf(ref.sessionId),
    messages: () => data.messages,
    parts: (messageId) => data.parts[messageId] ?? NO_PARTS,
    isPendingMessage: isPending,
    conversation: (): TranscriptConversation | undefined => (phase.state().kind === "loading" ? undefined : data),
    turnSettlePending: (userMessageId) => isReading(phase.state()) && lastUserId() === userMessageId,
    queue,
    requests: () => deps.requests.openFor(ref.sessionId),
    requestState: deps.requests.stateOf,
    todos: () => data.todos,
    diff: () => data.diff,
    goal: goal.goal,
    goalActions: goal.actions,
    controlGoal: goal.control,
    hasOlder: () => olderCursor() !== undefined,
    olderState: older.state,
    loadOlder,
    reload: readSnapshot,
    send,
    stop,
    reply: (requestId, reply) => deps.requests.reply(ref, requestId, reply),
    apply,
    gap: () => {
      void readSnapshot()
      void queue.reread()
    },
    dispose: deltas.drop,
  }
}
