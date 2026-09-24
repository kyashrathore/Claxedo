import { createEffect, on } from "solid-js"
import { sessionComposerKey, useComposerStore } from "@/composer"
import type { SessionView } from "@/session"
import { queuedMessageText } from "./timeline"

export function createQueueEdit(view: SessionView) {
  const store = useComposerStore()
  const key = sessionComposerKey(view.ref)
  createEffect(
    on(view.queue.editing, (seq) => {
      if (seq === undefined) return
      const record = view.queue.items().find((item) => item.seq === seq)
      if (!record) return
      const text = queuedMessageText(record)
      store.setPrompt(key, [{ type: "text", content: text, start: 0, end: text.length }], text.length)
    }),
  )
  return {
    accepted: () => {
      const seq = view.queue.editing()
      if (seq !== undefined) view.queue.remove(seq)
    },
  }
}
