import { createEffect, on } from "solid-js"
import { queuedDraft, sessionComposerKey, useComposerStore } from "@/composer"
import type { PromptInput } from "@/server"
import type { SessionView } from "@/session"

export function createQueueEdit(view: SessionView) {
  const store = useComposerStore()
  const key = () => view.queue.editing() === undefined ? sessionComposerKey(view.ref) : `${sessionComposerKey(view.ref)}:queue:${view.queue.editing()}`
  createEffect(
    on(view.queue.editing, (seq) => {
      if (seq === undefined) return
      const record = view.queue.items().find((item) => item.seq === seq)
      if (!record) return
      store.restore(key(), queuedDraft(record.parts))
    }),
  )
  return {
    key,
    edit: {
      active: () => view.queue.editing() !== undefined,
      get replace() {
        const seq = view.queue.editing()
        return (input: PromptInput) => seq === undefined ? Promise.resolve(false) : view.replaceQueued(seq, input)
      },
      cancel: () => {
        const seq = view.queue.editing()
        if (seq === undefined) return
        view.queue.cancelEdit(seq)
      },
    },
  }
}
