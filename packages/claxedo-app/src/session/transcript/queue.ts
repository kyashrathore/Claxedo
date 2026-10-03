import { createSignal, type Accessor, type Setter } from "solid-js"
import { ServerError, toAppError, type AppError, type PromptInput, type QueuedPrompt, type QueuedPromptAction, type Server, type SessionLocation } from "@/server"
import type { QueuedMessages } from "../view/timeline/model"

export type SessionQueue = Omit<QueuedMessages, "beginEdit"> & {
  readonly beginEdit: (seq: number, editable: boolean) => Promise<boolean>
}

export type QueueInternal = SessionQueue & {
  readonly reread: () => Promise<void>
  readonly replace: (seq: number, input: PromptInput) => Promise<boolean>
}

type Field<T> = { readonly get: Accessor<T>; readonly set: Setter<T> }

type QueueContext = {
  readonly server: Server
  readonly ref: SessionLocation
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
  const [get, set] = createSignal(initial)
  return { get, set }
}

async function read(context: QueueContext): Promise<void> {
  try {
    const next = await context.server.sessions.queue(context.ref)
    context.items.set(next)
    context.readError.set(undefined)
    context.onRead(next)
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
    if (result.ok && action !== "hold" && context.editing.get() === seq) context.editing.set(undefined)
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
  if (!messageId) throw new ServerError({ class: "conflict", code: "queue_edit_missing", message: "The queued message is no longer available; your edit has not been sent" })
  const replaced = await context.server.sessions.replaceQueued(context.ref, seq, input, messageId)
  if (replaced) context.editing.set(undefined)
  await reread(context)
  return replaced
}

async function beginEdit(context: QueueContext, seq: number, editable: boolean): Promise<boolean> {
  if (context.editing.get() !== undefined) return false
  if (!editable) {
    context.controlError.set({ class: "invalid", message: "This queued attachment cannot be edited", retryable: false })
    return false
  }
  if (!(await control(context, seq, "hold"))) return false
  context.editing.set(seq)
  return true
}

export function createQueue(server: Server, ref: SessionLocation, onRead: (items: readonly QueuedPrompt[]) => void): QueueInternal {
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
    beginEdit: (seq, editable) => beginEdit(context, seq, editable),
    cancelEdit: (seq) => {
      if (!context.items.get().some((item) => item.seq === seq)) context.editing.set(undefined)
      else void control(context, seq, "release")
    },
    reread: () => reread(context),
    replace: (seq, input) => replace(context, seq, input),
  }
}
