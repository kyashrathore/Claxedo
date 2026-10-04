import { createMemo, createSignal, type Accessor } from "solid-js"
import type { SessionView } from "@/session"
import type { FileContextItem, QuoteContextItem } from "../model"
import { promptDesignPlaceholder } from "../role-gate"
import type { ComposerSetup } from "../setup"
import type { PromptInputMode } from "./editor-surface"
import { PROMPT_EXAMPLES } from "./examples"
import { promptPlaceholder } from "./placeholder"

export function createEditorPlaceholder(input: {
  composer: ComposerSetup
  mode: Accessor<PromptInputMode>
  fileItems: Accessor<FileContextItem[]>
  quoteItems: Accessor<QuoteContextItem[]>
  view: Accessor<SessionView | undefined>
  readOnly: Accessor<boolean | undefined>
}): Accessor<string> {
  const t = input.composer.t
  const [placeholderIndex] = createSignal(Math.floor(Math.random() * PROMPT_EXAMPLES.length))
  const commentCount = createMemo(() =>
    input.mode() === "shell" ? 0 : input.fileItems().filter((item) => !!item.comment?.trim()).length + input.quoteItems().length,
  )
  const suggest = createMemo(() => !input.view()?.messages().some((message) => message.role === "user"))
  const placeholder = () =>
    promptPlaceholder({
      mode: input.mode(),
      commentCount: commentCount(),
      example: suggest() ? t(PROMPT_EXAMPLES[placeholderIndex()]) : "",
      suggest: suggest(),
      t,
    })
  return () =>
    input.composer.draft().goalArmed
      ? t("prompt.goal.placeholder")
      : promptDesignPlaceholder({ authorityBlock: input.readOnly() ? "session-share" : undefined, mode: input.mode(), shellPlaceholder: placeholder() })
}
