import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import type { Prompt } from "@/features/session/providers/prompt"
import type { PromptRetryAction } from "../prompt-input-props"
import type { SubmitMode } from "../../submit/index"
import type { SubmitBlock } from "@/features/session/composer/submit-block-reason"
import { addRegisteredConversationMessage, removeRegisteredConversationMessage } from "../../conversation/conversation-registry"
import type { PromptTimelineOptimisticStore } from "../../submit/index"

export function createSubmitOptimisticTimeline(): PromptTimelineOptimisticStore {
  return {
    add: (item) => addRegisteredConversationMessage(item),
    remove: (item) => removeRegisteredConversationMessage(item),
  }
}

export type PromptBootState = {
  harness: string
  sessionID?: string
  phase?: "booting" | "sending"
}

export function createPromptInputBootState(input: {
  readonly working: Accessor<boolean>
  readonly canAbort: Accessor<boolean>
}) {
  const [boot, setBoot] = createSignal<PromptBootState>()
  const booting = createMemo(() => !!boot())
  const busy = createMemo(() => booting() || input.working())
  // A newly-created session is abortable as soon as its first prompt starts
  // dispatching. The canonical session status event can land a tick later, so
  // waiting for `working()` leaves the UI showing Stop while Escape is inert.
  // A pure boot (before a session id exists) is deliberately not abortable.
  const sendingFirstPrompt = createMemo(() => {
    const item = boot()
    return item?.phase === "sending" && !!item.sessionID
  })
  const stoppable = createMemo(() => (input.working() || sendingFirstPrompt()) && input.canAbort())
  const bootText = createMemo(() => {
    const item = boot()
    if (!item) return ""
    if (item.phase === "sending") return "Sending first message..."
    return `Booting ${item.harness}...`
  })

  createEffect(() => {
    if (!boot()) return
    if (!input.working()) return
    setBoot()
  })

  return {
    boot,
    setBoot,
    booting,
    busy,
    stoppable,
    bootText,
  }
}

type LastSubmittedSnapshot = {
  prompt: Prompt
  mode: SubmitMode
}

export function createPromptInputSubmitRetry(input: {
  readonly resetKey: Accessor<string>
  readonly rawHandleSubmit: (event: Pick<Event, "preventDefault">) => unknown
  readonly authorityBlocked: Accessor<boolean>
  /**
   * Any standing block reason. Actionable reasons leave the Send button
   * clickable so it can explain itself; the handler still refuses to submit.
   */
  readonly submitBlocked?: Accessor<boolean>
  /** Standing block, used to route Enter to the model picker for `no-model`. */
  readonly submitBlock?: Accessor<SubmitBlock | null>
  readonly onChooseModel?: VoidFunction
  readonly prompt: {
    current(): Prompt
    set(prompt: Prompt, cursor?: number): void
  }
  readonly imageCount: Accessor<number>
  readonly commentCount: Accessor<number>
  readonly mode: Accessor<SubmitMode>
  readonly setMode: (mode: SubmitMode) => void
  readonly promptLength: (prompt: Prompt) => number
  readonly clearBoot: VoidFunction
  readonly registerRetry?: (retry?: PromptRetryAction) => void
}) {
  const [lastSubmitted, setLastSubmitted] = createSignal<LastSubmittedSnapshot | undefined>(undefined)

  createEffect(
    on(
      input.resetKey,
      () => {
        input.clearBoot()
        setLastSubmitted(undefined)
        input.registerRetry?.(retryPrompt)
      },
      { defer: true },
    ),
  )

  // Only `preventDefault` is read, and the retry path below replays a submit
  // without a real DOM event — so the parameter states what it uses.
  const handleSubmit = async (event: Pick<Event, "preventDefault">) => {
    if (input.authorityBlocked() || input.submitBlocked?.()) {
      if (input.submitBlock?.()?.reason === "no-model") input.onChooseModel?.()
      return event.preventDefault()
    }
    const currentPrompt = input.prompt.current()
    const text = currentPrompt
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
      .trim()
    const hasContent = text.length > 0 || input.imageCount() > 0 || input.commentCount() > 0
    if (hasContent) {
      // Capture before the submit pipeline clears the editor / resets the
      // prompt scope. Deep-copy the parts so a later in-place mutation of
      // the live prompt store does not retroactively change the snapshot.
      setLastSubmitted({
        prompt: currentPrompt.map((part) => ({ ...part })) as Prompt,
        mode: input.mode(),
      })
    }
    return await input.rawHandleSubmit(event)
  }

  const retryPrompt: PromptRetryAction = (prompt) => {
    const snapshot = prompt
      ? { prompt, mode: "normal" as const }
      : lastSubmitted()
    if (!snapshot) return undefined
    // Restore the captured payload, then route through the same submit
    // pipeline. The downstream submit re-runs all phase resolution from scratch.
    input.prompt.set(
      snapshot.prompt.map((part) => ({ ...part })) as Prompt,
      input.promptLength(snapshot.prompt),
    )
    input.setMode(snapshot.mode)
    return handleSubmit({ preventDefault: () => undefined })
  }

  input.registerRetry?.(retryPrompt)
  onCleanup(() => input.registerRetry?.())

  return {
    handleSubmit,
    onRetry: createMemo<(() => void) | undefined>(() => (lastSubmitted() ? () => void retryPrompt() : undefined)),
  }
}

/** Ignore late boot updates after the composer has switched to another draft. */
export function createSubmitBootWriter(input: {
  bootScope?: Accessor<string>
  setBooting?: (value?: PromptBootState) => void
}) {
  const scope = input.bootScope?.()
  return (value?: PromptBootState) => {
    if (input.bootScope && input.bootScope() !== scope) return
    input.setBooting?.(value)
  }
}
