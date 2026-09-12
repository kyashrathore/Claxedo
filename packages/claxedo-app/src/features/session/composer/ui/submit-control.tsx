import { type Accessor, type JSX, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { SessionStatusStage, type SessionStatusStage as SessionStatusStageValue } from "@/features/session/ui/components/session-status-stage"
import type { SubmitBlock } from "@/features/session/composer/submit-block-reason"

export function PromptSubmitControl(props: {
  stage: Accessor<SessionStatusStageValue>
  queued: Accessor<boolean>
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
  onChooseModel: VoidFunction
  readOnlyBlocked: Accessor<boolean>
  sendLabel: string
  stopLabel: string
  readOnlyLabel: string
}) {
  // Actionable block reasons keep the button clickable but dimmed: a missing
  // model opens the model picker; other reasons flash the explanation, since
  // touch users never see the hover tooltip.
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

  // Stop is what this control means only while there is nothing to send. With a
  // draft in the composer it means Send, and the draft goes to the running turn.
  const stopping = () => props.busy() && props.blank()

  return (
    <>
      <Show when={props.queued()}>
        <div
          data-testid="composer-queued"
          class="flex items-center gap-1.5 rounded-md border border-border-base bg-surface-raised-base px-2 py-1 text-12-medium text-text-weak"
          role="status"
          aria-live="polite"
        >
          <span>Queued</span>
        </div>
      </Show>
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
        {/* Booting lives inside the send button — a spinner where the arrow
            will be — rather than as a chip beside it. The circle is the same
            control the boot is delaying, so it is the honest place to say so;
            the words stay in the tooltip. Both states share the DOM node and
            cross-fade so the arrow's arrival reads as the button waking up. */}
        <div class="relative">
          <IconButton
            data-action="prompt-submit"
            data-booting={props.booting() || undefined}
            type="submit"
            disabled={props.disabled()}
            tabIndex={props.excludeFromTab() ? -1 : undefined}
            onClick={explain}
            icon={stopping() ? "stop" : props.mode() === "shell" ? "arrow-undo-down" : "send"}
            variant="primary"
            class="size-8 rounded-full bg-v2-background-bg-inverse p-[7px] text-v2-icon-icon-inverse shadow-none transition-opacity duration-150 hover:opacity-90 disabled:opacity-35 [&[data-booting]>[data-component=icon]]:opacity-0 [&>[data-component=icon]]:transition-opacity [&>[data-component=icon]]:duration-150"
            classList={{ "opacity-50": actionable() }}
            aria-label={
              stopping()
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
          <Show when={props.booting()}>
            <Spinner class="pointer-events-none absolute inset-0 m-auto size-3.5 text-v2-icon-icon-inverse" />
          </Show>
        </div>
      </Tooltip>
    </>
  )
}
