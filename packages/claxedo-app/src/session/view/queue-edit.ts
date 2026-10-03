import { createEffect, on } from "solid-js"
import { queuedDraft, sessionComposerKey, type ComposerStore } from "@/composer"
import type { PromptInput, QueuedPrompt } from "@/server"
import type { SessionView } from "@/session"
import type { QueuedMessages } from "./timeline/model"

type DraftForks = Pick<ComposerStore, "forkDraft" | "joinFork" | "dropFork">

export function createQueueEdit(view: SessionView, store: DraftForks) {
  const key = sessionComposerKey(view.ref)
  createEffect(
    on(view.queue.editing, (seq, previous) => {
      if (seq !== undefined) return
      if (previous === undefined) store.joinFork(key)
      else store.dropFork(key)
    }),
  )
  createEffect(
    on([view.queue.editing, view.queue.items], ([seq, items]) => {
      if (seq === undefined || items.some((item) => item.seq === seq)) return
      store.joinFork(key)
      view.queue.cancelEdit(seq)
    }),
  )
  const beginEdit = async (record: QueuedPrompt) => {
    const draft = queuedDraft(record.parts)
    if (await view.queue.beginEdit(record.seq, draft !== undefined) && draft) store.forkDraft(key, draft)
  }
  const queued: QueuedMessages = { ...view.queue, beginEdit: (record) => void beginEdit(record) }
  return {
    queued,
    edit: {
      active: () => view.queue.editing() !== undefined,
      get replace() {
        const seq = view.queue.editing()
        return (input: PromptInput) => seq === undefined ? Promise.resolve(false) : view.replaceQueued(seq, input)
      },
      cancel: () => {
        const seq = view.queue.editing()
        if (seq !== undefined) view.queue.cancelEdit(seq)
      },
    },
  }
}
