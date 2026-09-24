import { createSignal } from "solid-js"
import type { AppError, QueuedPrompt, QueuedPromptAction, Server, SessionRef } from "@/server"
import type { QueuedMessage, QueuedMessages } from "../view/timeline/model"
import { toAppError } from "../requests"

export type QueueInternal = QueuedMessages & { readonly reread: () => Promise<void> }

const NO_ITEMS: readonly QueuedPrompt[] = Object.freeze([])

export function createQueue(server: Server, ref: SessionRef, onRead: (items: readonly QueuedPrompt[]) => void): QueueInternal {
  const [items, setItems] = createSignal<readonly QueuedPrompt[]>(NO_ITEMS)
  const [readError, setReadError] = createSignal<AppError>()
  const [pending, setPending] = createSignal<number>()
  const [controlError, setControlError] = createSignal<AppError>()
  const [editing, setEditing] = createSignal<number>()
  const inFlight = { current: undefined as Promise<void> | undefined }

  async function read(): Promise<void> {
    try {
      const next = await server.sessions.queue(ref)
      setItems(next)
      setReadError(undefined)
      onRead(next)
      if (editing() !== undefined && !next.some((item) => item.seq === editing())) setEditing(undefined)
    } catch (cause) {
      setReadError(toAppError(cause))
    }
  }

  function reread(): Promise<void> {
    inFlight.current ??= read().finally(() => {
      inFlight.current = undefined
    })
    return inFlight.current
  }

  async function control(seq: number, action: QueuedPromptAction): Promise<boolean> {
    setPending(seq)
    setControlError(undefined)
    try {
      const result = await server.sessions.controlQueued(ref, seq, action)
      if (!result.ok && result.status !== "pending" && result.message) {
        setControlError({ class: "conflict", message: result.message, retryable: false })
      }
      if (action !== "hold" && editing() === seq) setEditing(undefined)
      await reread()
      return result.ok
    } catch (cause) {
      setControlError(toAppError(cause))
      return false
    } finally {
      setPending(undefined)
    }
  }

  async function beginEdit(record: QueuedMessage): Promise<void> {
    if (await control(record.seq, "hold")) setEditing(record.seq)
  }

  return {
    items,
    loadFailed: () => readError() !== undefined,
    pending,
    error: () => controlError()?.message,
    editing,
    reload: () => void reread(),
    sendNow: (seq) => void control(seq, "steer"),
    remove: (seq) => void control(seq, "cancel"),
    beginEdit: (record) => void beginEdit(record),
    cancelEdit: (seq) => void control(seq, "release"),
    reread,
  }
}
