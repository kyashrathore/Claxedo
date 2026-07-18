import { type Accessor, type JSX, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
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
  // Explain-on-intent (T5 §B3): actionable block reasons leave the button
  // clickable-but-dimmed. A click flashes the reason forced-open — this is the
  // click/touch fallback for users where hover never fires. The reason is also
  // the tooltip's hover value, so pointer users see it on hover already.
  const [flash, setFlash] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const explain = () => {
    if (!props.block()?.actionable) return
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
            icon={props.busy() ? "stop" : props.mode() === "shell" ? "arrow-undo-down" : "arrow-up"}
            variant="primary"
            class="size-7 rounded-md p-[6px] text-v2-icon-icon-muted shadow-[var(--v2-elevation-button-contrast)] transition-opacity duration-150 disabled:opacity-50"
            classList={{ "opacity-50": actionable() }}
            style={{
              "background-image":
                "linear-gradient(180deg,var(--v2-alpha-light-20) 0%,var(--v2-alpha-light-0) 100%),linear-gradient(90deg,var(--v2-background-bg-contrast) 0%,var(--v2-background-bg-contrast) 100%)",
            }}
            aria-label={
              props.busy()
                ? props.stopLabel
                : props.booting()
                  ? props.bootText()
                  : props.block()
                    ? props.block()!.copy
                    : props.readOnlyBlocked() ? props.readOnlyLabel : props.sendLabel
            }
          />
        </div>
      </Tooltip>
    </>
  )
}
