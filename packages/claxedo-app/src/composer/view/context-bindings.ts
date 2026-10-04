import { createMemo, createSignal, type Accessor } from "solid-js"
import type { Panel } from "@/panel"
import type { FileContextItem, QuoteContextItem } from "../model"
import type { ComposerSetup } from "../setup"
import { commentFocus } from "./comment-routing"
import type { PromptContextStripProps } from "./context-strip"
import type { PromptInputMode } from "./editor-surface"

export function createPromptContextBindings(input: {
  composer: ComposerSetup
  mode: Accessor<PromptInputMode>
  fileItems: Accessor<FileContextItem[]>
  quoteItems: Accessor<QuoteContextItem[]>
  panel: Panel
}): Pick<
  PromptContextStripProps,
  "contextItems" | "contextActive" | "openComment" | "removeContextItem" | "annotations"
> {
  const [activeComment, setActiveComment] = createSignal<string>()
  const contextItems = createMemo(() => (input.mode() === "shell" ? input.fileItems().filter((item) => !item.comment?.trim()) : input.fileItems()))

  return {
    get contextItems() {
      return contextItems()
    },
    contextActive: (item) => !!item.commentId && item.commentId === activeComment(),
    openComment: (item) => {
      const focus = commentFocus(item)
      if (!focus) return
      setActiveComment(item.commentId)
      input.panel.show(focus)
    },
    removeContextItem: (item) => input.composer.store.removeContext(input.composer.key(), item.key),
    annotations: createAnnotationBindings(input),
  }
}

function createAnnotationBindings(input: {
  composer: ComposerSetup
  mode: Accessor<PromptInputMode>
  quoteItems: Accessor<QuoteContextItem[]>
  panel: Panel
}): PromptContextStripProps["annotations"] {
  const store = input.composer.store
  return {
    get items() {
      return input.mode() === "shell" ? [] : input.quoteItems()
    },
    get composerKey() {
      return input.composer.key()
    },
    reveal: (item) => {
      if (item.source.kind === "file") input.panel.show({ kind: "file", path: item.source.path })
    },
    remove: (item) => store.removeContext(input.composer.key(), item.key),
    removeAll: () => {
      const key = input.composer.key()
      store.setContext(key, store.draft(key).context.filter((item) => item.type !== "quote"))
    },
  }
}
