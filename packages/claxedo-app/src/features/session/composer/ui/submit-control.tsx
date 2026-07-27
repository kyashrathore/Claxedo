import { type Accessor, type JSX, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { SessionStatusStage, type SessionStatusStage as SessionStatusStageValue } from "@/features/session/ui/components/session-status-stage"
import type { SubmitBlock } from "@/features/session/composer/submit-block-reason"

export function PromptSubmitControl(props: {
  stage: Accessor<SessionStatusStageValue>
  busy: Accessor<boolean>
  onCancel: VoidFunction
  onRetry: Accessor<(() => void) | undefined>
  booting: Accessor<boolean>
  working: Accessor<boolean>
  blank: Accessor<boolean>
  tip: Accessor<JSX.Element>
  bootText: Accessor<string>
  mode: Accessor<"normal" | "shell">
  disabled: Accessor<boolean>
  excludeFromTab: Accessor<boolean>
  block: Accessor<SubmitBlock | null>
  onConnectAI: VoidFunction
  onChooseModel: VoidFunction
  readOnlyBlocked: Accessor<boolean>
  sendLabel: string
  stopLabel: string
  readOnlyLabel: string
}) {
  // Resolve-on-intent (T5 §B3): actionable block reasons leave the button
  // clickable-but-dimmed. Missing-model and missing-provider clicks open their
  // remedy directly; runtime failures flash the reason as the click/touch
  // fallback for users where hover never fires.
  const [flash, setFlash] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const explain: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (event) => {
    const block = props.block()
    if (!block?.actionable) return
    event.preventDefault()
    if (block.reason === "no-model") {
      props.onChooseModel()
      return
    }
    if (block.reason === "no-credential") {
      props.onConnectAI()
      return
    }
    setFlash(true)
    clearTimer()
    timer = setTimeout(() => setFlash(false), 3200)
  }
  // Dismiss the flash the instant the block clears (e.g. a model gets connected).
  createEffect(() => {
    if (!props.block()) {
      clearTimer()
      setFlash(false)
    }
  })
  onCleanup(clearTimer)

  const actionable = () => !!props.block()?.actionable

  const tipContent = () => {
    const block = props.block()
    if (!block) return props.tip()
    return (
      <div class="flex items-center gap-2">
        <span>{block.copy}</span>
        <Show when={block.reason === "no-credential"}>
          <button
            type="button"
            data-action="prompt-block-connect"
            class="rounded border border-border-base px-1.5 py-0.5 text-11-medium text-text-base transition-colors duration-150 hover:bg-surface-raised-base"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setFlash(false)
              props.onConnectAI()
            }}
          >
            Connect AI
          </button>
        </Show>
        <Show when={block.reason === "no-model"}>
          <button
            type="button"
            data-action="prompt-block-model"
            class="rounded border border-border-base px-1.5 py-0.5 text-11-medium text-text-base transition-colors duration-150 hover:bg-surface-raised-base"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setFlash(false)
              props.onChooseModel()
            }}
          >
            Choose model
          </button>
        </Show>
      </div>
    )
  }

  return (
    <>
      <SessionStatusStage
        stage={props.stage()}
        busy={props.busy()}
        onCancel={props.onCancel}
        onRetry={props.onRetry()}
      />
      <Tooltip
        placement="top"
        // A standing block reason always has something to say; otherwise keep the
        // old rule (no tooltip on an idle, empty composer).
        inactive={!props.block() && !props.booting() && !props.working() && props.blank()}
        forceOpen={flash() && actionable()}
        value={tipContent()}
      >
        <div class="flex items-center gap-2">
          <Show when={props.booting()}>
            <div class="flex items-center gap-1.5 rounded-md border border-border-base bg-surface-raised-base px-2 py-1 text-12-medium text-text-weak">
              <Spinner class="size-3.5 shrink-0" />
              <span>{props.bootText()}</span>
            </div>
          </Show>
          <IconButton
            data-action="prompt-submit"
            type="submit"
            disabled={props.disabled()}
            tabIndex={props.excludeFromTab() ? -1 : undefined}
            onClick={explain}
            icon={props.busy() ? "stop" : props.mode() === "shell" ? "arrow-undo-down" : "send"}
            variant="primary"
            class="size-8 rounded-full bg-v2-background-bg-inverse p-[7px] text-v2-icon-icon-inverse shadow-none transition-opacity duration-150 hover:opacity-90 disabled:opacity-35"
            classList={{ "opacity-50": actionable() }}
            aria-label={
              props.busy()
                ? props.stopLabel
                : props.booting()
                  ? props.bootText()
                  // readOnlyBlocked is checked before the generic block copy: viewer-role
                  // always wins submitBlockReason's priority ordering (see
                  // submit-block-reason.ts), so without this the dedicated shorter
                  // `readOnlyLabel` ("Read-only workspace") would never be reachable —
                  // block()!.copy's "Read-only workspace (viewer)" (the composer
                  // placeholder's wording) would always shadow it.
                  : props.readOnlyBlocked()
                    ? props.readOnlyLabel
                    : props.block()
                      ? props.block()!.copy
                      : props.sendLabel
            }
          />
        </div>
      </Tooltip>
    </>
  )
}
