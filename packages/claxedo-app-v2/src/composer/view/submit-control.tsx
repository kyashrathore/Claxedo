import { type Accessor, type JSX, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { ClaxedoIconButton as IconButton, Spinner, Tooltip } from "@/ui"
import { SessionStatusStage, type SessionStatusStage as SessionStatusStageValue } from "./session-status-stage"
import type { SubmitBlock } from "../submit-block-reason"

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
  onChooseModel: VoidFunction
  readOnlyBlocked: Accessor<boolean>
  sendLabel: string
  stopLabel: string
  readOnlyLabel: string
}) {
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

  const stopping = () => props.busy() && props.blank()

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
        inactive={!props.block() && !props.booting() && !props.working() && props.blank()}
        forceOpen={flash() && actionable()}
        value={tipContent()}
      >
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
            class="composer-submit size-8 rounded-full bg-v2-background-bg-inverse p-[7px] text-v2-icon-icon-inverse shadow-none transition-opacity duration-150 hover:opacity-90 disabled:opacity-35"
            classList={{ "opacity-50": actionable() }}
            aria-label={
              stopping()
                ? props.stopLabel
                : props.booting()
                  ? props.bootText()
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
