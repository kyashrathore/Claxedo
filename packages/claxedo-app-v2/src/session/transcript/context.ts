import { createSignal, type Accessor, type Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { machine, type Machine } from "@/lib/machine"
import type { Server, SessionRef } from "@/server"
import type { OlderState } from "@/session"
import type { SessionListInternal } from "../list"
import type { RequestsInternal } from "../requests"
import { dropQueuedStubs, type SetTranscript } from "./conversation"
import { createSessionGoal, type SessionGoalStore } from "./goal"
import {
  OLDER_IDLE,
  emptyTranscript,
  initialPhase,
  olderTransition,
  phaseTransition,
  type OlderEvent,
  type SessionPhase,
  type SessionPhaseEvent,
  type TranscriptData,
} from "./model"
import { createQueue, type QueueInternal } from "./queue"
import { createSessionSubagents, type SessionSubagentsStore } from "./subagents"

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
  readonly phase: Machine<SessionPhase, SessionPhaseEvent>
  readonly older: Machine<OlderState, OlderEvent>
  readonly olderCursor: Accessor<string | undefined>
  readonly setOlderCursor: Setter<string | undefined>
  readonly queue: QueueInternal
  readonly goal: SessionGoalStore
  readonly subagents: SessionSubagentsStore
  readonly snapshotRead: { current: Promise<void> | undefined }
  readonly olderRead: { current: Promise<void> | undefined }
}

export function createTranscriptContext(server: Server, ref: SessionRef, deps: TranscriptDeps): TranscriptContext {
  const [data, setData] = createStore(emptyTranscript())
  const [olderCursor, setOlderCursor] = createSignal<string>()
  return {
    server,
    ref,
    deps,
    data,
    setData,
    phase: machine(initialPhase, phaseTransition),
    older: machine(OLDER_IDLE, olderTransition),
    olderCursor,
    setOlderCursor,
    queue: createQueue(server, ref, (items) => dropQueuedStubs(setData, data, items)),
    goal: createSessionGoal(server, ref),
    subagents: createSessionSubagents(server, ref),
    snapshotRead: { current: undefined },
    olderRead: { current: undefined },
  }
}
