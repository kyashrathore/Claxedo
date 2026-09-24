import {
  toAppError,
  type AppError,
  type PlacementId,
  type Server,
  type TerminalFrame,
  type TerminalId,
  type TerminalStream,
  type TerminalStreamClose,
} from "@/server"
import type { Machine } from "@/lib/machine"
import type { TerminalBackend } from "./backend/types"
import { closeError, type TerminalConnection, type TerminalConnectionEvent } from "./model"
import { createWriteQueue, type WriteQueue } from "./write-queue"
import { capabilityResponses } from "./capability-responder"
import { stripTerminalReplies } from "./input-reply-filter"
import { createReconnectTimer, decideReconnect, isRetriableClose, type ReconnectTimer } from "./reconnect"
import { createResizePublisher, type ResizePublisher } from "./resize"

const NORMAL_CLOSE = 1000
const ABNORMAL_CLOSE = 1006
const POLICY_CLOSE = 1008
const OVERLOAD_CLOSE = 4000

export type AttachInput = {
  readonly server: Server
  readonly placementId: PlacementId
  readonly terminalId: TerminalId
  readonly backend: TerminalBackend
  readonly host: HTMLElement
  readonly connection: Machine<TerminalConnection, TerminalConnectionEvent>
  readonly likelyTui: boolean
  readonly onPublishFailed: (error: unknown) => void
}

export type Attachment = {
  readonly send: (data: string) => void
  readonly retry: () => void
  readonly dispose: () => void
}

type AttachState = {
  readonly input: AttachInput
  readonly queue: WriteQueue
  readonly resize: ResizePublisher
  readonly timer: ReconnectTimer
  cursor: number
  replayReady: boolean
  disposed: boolean
  stream: TerminalStream | undefined
}

function emit(state: AttachState, event: TerminalConnectionEvent): void {
  state.input.connection.send(event)
}

function overload(state: AttachState): void {
  state.stream?.close()
  const error: AppError = { class: "internal", message: "Terminal output overloaded the write queue", retryable: false }
  emit(state, { type: "failed", failure: "overload", error })
}

function restoreFrame(state: AttachState, frame: Extract<TerminalFrame, { kind: "cursor" }>): void {
  if (!frame.checkpoint) return state.queue.flushPending()
  state.queue.beginRestore()
  state.input.backend.restoreCheckpoint(frame.checkpoint).then(
    () => {
      if (state.disposed) return
      state.queue.flushPending()
      state.input.backend.fit()
    },
    (error: unknown) => {
      if (state.disposed) return
      state.stream?.close()
      emit(state, {
        type: "failed",
        failure: "restore",
        error: toAppError(error),
      })
    },
  )
}

function receiveFrame(state: AttachState, frame: TerminalFrame): void {
  if (state.disposed) return
  if (frame.kind === "cursor") {
    state.cursor = frame.cursor
    state.replayReady = true
    return restoreFrame(state, frame)
  }
  state.cursor += frame.data.length
  if (state.replayReady) {
    for (const response of capabilityResponses(frame.data, () => state.input.backend.getDefaultColors()))
      state.stream?.send(response)
  }
  state.queue.push(frame.data)
}

async function decideAfterClose(state: AttachState, error: AppError): Promise<void> {
  const current = state.input.connection.state()
  const attempt = current.kind === "detached" ? current.attempt : 1
  const presence = await state.input.server.terminals.presence(state.input.placementId, state.input.terminalId)
  if (state.disposed) return
  const decision = decideReconnect({ presence, attempt })
  if (decision.kind === "gone") return emit(state, { type: "gone" })
  if (decision.kind === "giveUp") return emit(state, { type: "failed", failure: "closed", error })
  state.timer.schedule(decision.delayMs, () => {
    emit(state, { type: "retry" })
    void connectStream(state)
  })
}

function recover(state: AttachState, close: TerminalStreamClose): void {
  const error = closeError(close)
  emit(state, { type: "closed", error })
  decideAfterClose(state, error).catch((cause: unknown) => {
    if (!state.disposed) emit(state, { type: "failed", failure: "closed", error: toAppError(cause) })
  })
}

function handleClose(state: AttachState, close: TerminalStreamClose): void {
  if (state.disposed) return
  state.stream = undefined
  if (close.code === NORMAL_CLOSE) return emit(state, { type: "exited" })
  if (close.code === POLICY_CLOSE) return emit(state, { type: "gone" })
  if (close.code === OVERLOAD_CLOSE) return
  if (!isRetriableClose(close.code)) return emit(state, { type: "failed", failure: "closed", error: closeError(close) })
  recover(state, close)
}

function opened(state: AttachState): void {
  if (state.disposed) return
  emit(state, { type: "opened" })
  state.resize.onOpen()
}

async function connectStream(state: AttachState): Promise<void> {
  if (state.disposed) return
  state.replayReady = false
  const { server, placementId, terminalId } = state.input
  try {
    const stream = await server.terminals.attach({
      placementId,
      terminalId,
      cursor: state.cursor,
      onOpen: () => opened(state),
      onFrame: (frame) => receiveFrame(state, frame),
      onClose: (close) => handleClose(state, close),
    })
    if (state.disposed) return stream.close()
    state.stream = stream
  } catch (error) {
    if (!state.disposed) recover(state, { code: ABNORMAL_CLOSE, reason: toAppError(error).message })
  }
}

function createAttachState(input: AttachInput): AttachState {
  const state: AttachState = {
    input,
    queue: createWriteQueue({
      write: (chunk, done) => input.backend.write(chunk, done),
      onOverload: () => overload(state),
    }),
    resize: createResizePublisher({
      backend: input.backend,
      host: input.host,
      likelyTui: input.likelyTui,
      publish: (size) => input.server.terminals.update(input.placementId, input.terminalId, { size }),
      onPublishFailed: input.onPublishFailed,
    }),
    timer: createReconnectTimer(),
    cursor: 0,
    replayReady: false,
    disposed: false,
    stream: undefined,
  }
  return state
}

export function attachTerminal(input: AttachInput): Attachment {
  const state = createAttachState(input)
  const disposeInput = input.backend.onData((data) => {
    const filtered = stripTerminalReplies(data)
    if (filtered) state.stream?.send(filtered)
  })
  void connectStream(state)
  return {
    send: (data) => state.stream?.send(data),
    retry: () => {
      if (state.disposed) return
      state.timer.cancel()
      emit(state, { type: "retry" })
      void connectStream(state)
    },
    dispose: () => {
      state.disposed = true
      state.timer.cancel()
      disposeInput()
      state.resize.dispose()
      state.queue.dispose()
      state.stream?.close()
      state.stream = undefined
    },
  }
}
