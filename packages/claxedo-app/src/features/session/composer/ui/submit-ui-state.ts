import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import type { Prompt } from "@/features/session/providers/prompt"
import type { PromptRetryAction } from "../prompt-input-props"
import type { SubmitMode } from "../../submit/index"

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
  const stoppable = createMemo(() => input.working() && input.canAbort())
  const bootText = createMemo(() => {
    const item = boot()
    if (!item) return ""
    if (item.phase === "sending") return "Sending first message..."
    return `Booting ${item.harness}...`
  })

  // Self-feeding as one scope: this reads `boot()` and clears it. The compute
  // only reports the pending boot while work is live; the clear now lands in
  // the untracked phase instead of re-invalidating its own read.
  createEffect(
    () => (input.working() ? boot() : undefined),
    (pending) => {
      if (pending) setBoot()
    },
  )

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
  readonly rawHandleSubmit: (event: Event) => unknown
  readonly roleSubmitBlocked: Accessor<boolean>
  /**
   * Any standing block reason (T5). Actionable reasons leave the Send button
   * clickable so it can explain itself; the handler still refuses to submit.
   */
  readonly submitBlocked?: Accessor<boolean>
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
    input.resetKey,
    () => {
      input.clearBoot()
      setLastSubmitted(undefined)
      input.registerRetry?.(retryPrompt)
    },
    { defer: true },
  )

  const handleSubmit = async (event: Event) => {
    if (input.roleSubmitBlocked() || input.submitBlocked?.()) return event.preventDefault()
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
    const snapshot = prompt ? { prompt, mode: "normal" as const } : lastSubmitted()
    if (!snapshot) return
    // Restore the captured payload, then route through the same submit
    // pipeline. The downstream submit re-runs all phase resolution from scratch.
    input.prompt.set(snapshot.prompt.map((part) => ({ ...part })) as Prompt, input.promptLength(snapshot.prompt))
    input.setMode(snapshot.mode)
    return handleSubmit({ preventDefault: () => undefined } as unknown as Event) // as-any: retry submit only needs preventDefault from the Event contract.
  }

  input.registerRetry?.(retryPrompt)
  onCleanup(() => input.registerRetry?.())

  return {
    handleSubmit,
    onRetry: createMemo<(() => void) | undefined>(() => (lastSubmitted() ? () => void retryPrompt() : undefined)),
  }
}
