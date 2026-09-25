import { type Accessor, type JSX, Show } from "solid-js"
import { ClaxedoIconButton as IconButton, Spinner, Tooltip } from "@/ui"
import { SessionStatusStage, type SessionStatusStage as SessionStatusStageValue } from "./session-status-stage"
import { createSubmitBlockFlash } from "./submit-block-flash"
import { SubmitBlockTip } from "./submit-block-tip"
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
  const { flash, explain, dismiss } = createSubmitBlockFlash(
    () => props.block(),
    () => props.onChooseModel(),
  )

  const actionable = () => !!props.block()?.actionable

  const tipContent = () => {
    const block = props.block()
    if (!block) return props.tip()
    return (
      <SubmitBlockTip
        block={block}
        onChooseModel={() => {
          dismiss()
          props.onChooseModel()
        }}
      />
    )
  }

  const stopping = () => props.busy() && props.blank()

  const label = () =>
    stopping()
      ? props.stopLabel
      : props.booting()
        ? props.bootText()
        : props.readOnlyBlocked()
          ? props.readOnlyLabel
          : props.block()
            ? props.block()!.copy
            : props.sendLabel

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
            aria-label={label()}
          />
          <Show when={props.booting()}>
            <Spinner class="pointer-events-none absolute inset-0 m-auto size-3.5 text-v2-icon-icon-inverse" />
          </Show>
        </div>
      </Tooltip>
    </>
  )
}
