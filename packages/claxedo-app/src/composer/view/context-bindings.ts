import { createMemo, createSignal, type Accessor } from "solid-js"
import type { Panel } from "@/panel"
import type { FileContextItem } from "../model"
import type { ComposerSetup } from "../setup"
import { commentFocus } from "./comment-routing"
import type { PromptContextStripProps } from "./context-strip"
import type { PromptInputMode } from "./editor-surface"

export function createPromptContextBindings(input: {
  composer: ComposerSetup
  mode: Accessor<PromptInputMode>
  fileItems: Accessor<FileContextItem[]>
  panel: Panel
}): Pick<PromptContextStripProps, "contextItems" | "contextActive" | "openComment" | "removeContextItem"> {
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
  }
}
