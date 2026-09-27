import { createSignal, type Accessor, type Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { machine, type Machine } from "@/lib/machine"
import type { Server, SessionRef, TranscriptPage } from "@/server"
import type { OlderState } from "@/session"
import type { SessionListInternal } from "../list"
import type { RequestsInternal } from "../requests"
import { appendDelta, dropQueuedStubs, type SetTranscript } from "./conversation"
import { committingFirst, createDeltaBuffer, type DeltaBuffer } from "./deltas"
import { createSessionGoal, type SessionGoalStore } from "./goal"
import {
  OLDER_IDLE,
  OUTLINE_LOADING,
  emptyTranscript,
  initialPhase,
  olderTransition,
  outlineTransition,
  phaseTransition,
  type OlderEvent,
  type OutlineEvent,
  type OutlineRead,
  type SessionPhase,
  type SessionPhaseEvent,
  type TranscriptData,
} from "./model"
import { createQueue, type QueueInternal } from "./queue"
import { createSessionSubagents, type SessionSubagentsStore } from "./subagents"
import { createSessionTodos, type SessionTodosStore } from "./todos"

export type TranscriptDeps = {
  readonly list: SessionListInternal
  readonly requests: RequestsInternal
}

export type TranscriptContext = {
  readonly server: Server
  readonly ref: SessionRef
  readonly deps: TranscriptDeps
  readonly data: TranscriptData
  readonly setData: SetTranscript
  readonly deltas: DeltaBuffer
  readonly phase: Machine<SessionPhase, SessionPhaseEvent>
  readonly older: Machine<OlderState, OlderEvent>
  readonly outline: Machine<OutlineRead, OutlineEvent>
  readonly olderCursor: Accessor<string | undefined>
  readonly setOlderCursor: Setter<string | undefined>
  readonly queue: QueueInternal
  readonly goal: SessionGoalStore
  readonly todos: SessionTodosStore
  readonly subagents: SessionSubagentsStore
  readonly snapshotRead: { current: Promise<void> | undefined }
  readonly latestTurnRead: { current: TranscriptPage | undefined }
  readonly olderRead: { current: Promise<void> | undefined }
}

export function createTranscriptContext(server: Server, ref: SessionRef, deps: TranscriptDeps): TranscriptContext {
  const [data, setStoreData] = createStore(emptyTranscript())
  const deltas = createDeltaBuffer((delta) => appendDelta(setStoreData, data, delta.messageId, delta.partId, delta.field, delta.delta))
  const setData = committingFirst(setStoreData, deltas)
  const [olderCursor, setOlderCursor] = createSignal<string>()
  return {
    server,
    ref,
    deps,
    data,
    setData,
    deltas,
    phase: machine(initialPhase, phaseTransition),
    older: machine(OLDER_IDLE, olderTransition),
    outline: machine(OUTLINE_LOADING, outlineTransition),
    olderCursor,
    setOlderCursor,
    queue: createQueue(server, ref, (items) => dropQueuedStubs(setData, data, items)),
    goal: createSessionGoal(server, ref),
    todos: createSessionTodos(),
    subagents: createSessionSubagents(),
    snapshotRead: { current: undefined },
    latestTurnRead: { current: undefined },
    olderRead: { current: undefined },
  }
}
