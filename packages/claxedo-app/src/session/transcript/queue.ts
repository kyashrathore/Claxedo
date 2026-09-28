import { createSignal, type Accessor, type Setter } from "solid-js"
import { toAppError, type AppError, type PromptInput, type QueuedPrompt, type QueuedPromptAction, type Server, type SessionRef } from "@/server"
import type { QueuedMessage, QueuedMessages } from "../view/timeline/model"

export type QueueInternal = QueuedMessages & {
  readonly reread: () => Promise<void>
  readonly replace: (seq: number, input: PromptInput) => Promise<boolean>
}

type Field<T> = { readonly get: Accessor<T>; readonly set: Setter<T> }

type QueueContext = {
  readonly server: Server
  readonly ref: SessionRef
  readonly onRead: (items: readonly QueuedPrompt[]) => void
  readonly items: Field<readonly QueuedPrompt[]>
  readonly readError: Field<AppError | undefined>
  readonly pending: Field<number | undefined>
  readonly controlError: Field<AppError | undefined>
  readonly editing: Field<number | undefined>
  readonly inFlight: { current: Promise<void> | undefined }
}

const NO_ITEMS: readonly QueuedPrompt[] = Object.freeze([])

function signalField<T>(initial: T): Field<T> {
  const [get, set] = createSignal<T>(initial)
  return { get, set }
}

async function read(context: QueueContext): Promise<void> {
  try {
    const next = await context.server.sessions.queue(context.ref)
    context.items.set(next)
    context.readError.set(undefined)
    context.onRead(next)
    const editing = context.editing.get()
    if (editing !== undefined && !next.some((item) => item.seq === editing)) context.editing.set(undefined)
  } catch (cause) {
    context.readError.set(toAppError(cause))
  }
}

function reread(context: QueueContext): Promise<void> {
  context.inFlight.current ??= read(context).finally(() => {
    context.inFlight.current = undefined
  })
  return context.inFlight.current
}

async function control(context: QueueContext, seq: number, action: QueuedPromptAction): Promise<boolean> {
  context.pending.set(seq)
  context.controlError.set(undefined)
  try {
    const result = await context.server.sessions.controlQueued(context.ref, seq, action)
    if (!result.ok && result.status !== "pending" && result.message) {
      context.controlError.set({ class: "conflict", message: result.message, retryable: false })
    }
    if (action !== "hold" && context.editing.get() === seq) context.editing.set(undefined)
    await reread(context)
    return result.ok
  } catch (cause) {
    context.controlError.set(toAppError(cause))
    return false
  } finally {
    context.pending.set(undefined)
  }
}

async function replace(context: QueueContext, seq: number, input: PromptInput): Promise<boolean> {
  const messageId = context.items.get().find((item) => item.seq === seq)?.messageId
  if (!messageId) return false
  const replaced = await context.server.sessions.replaceQueued(context.ref, seq, input, messageId)
  context.editing.set(undefined)
  await reread(context)
  return replaced
}

async function beginEdit(context: QueueContext, record: QueuedMessage): Promise<void> {
  if (await control(context, record.seq, "hold")) context.editing.set(record.seq)
}

export function createQueue(server: Server, ref: SessionRef, onRead: (items: readonly QueuedPrompt[]) => void): QueueInternal {
  const context: QueueContext = {
    server,
    ref,
    onRead,
    items: signalField(NO_ITEMS),
    readError: signalField<AppError | undefined>(undefined),
    pending: signalField<number | undefined>(undefined),
    controlError: signalField<AppError | undefined>(undefined),
    editing: signalField<number | undefined>(undefined),
    inFlight: { current: undefined },
  }
  return {
    items: context.items.get,
    loadFailed: () => context.readError.get() !== undefined,
    pending: context.pending.get,
    error: () => context.controlError.get()?.message,
    editing: context.editing.get,
    reload: () => void reread(context),
    sendNow: (seq) => void control(context, seq, "steer"),
    remove: (seq) => void control(context, seq, "cancel"),
    beginEdit: (record) => void beginEdit(context, record),
    cancelEdit: (seq) => void control(context, seq, "release"),
    reread: () => reread(context),
    replace: (seq, input) => replace(context, seq, input),
  }
}
