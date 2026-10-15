import type { Accessor, JSX } from "solid-js"
import { ClaxedoIconButton as IconButton, Tooltip } from "@/ui"
import { createSubmitBlockFlash } from "./submit-block-flash"
import { SubmitBlockTip } from "./submit-block-tip"
import type { SubmitBlock } from "../submit-block-reason"

export function PromptSubmitControl(props: {
  busy: Accessor<boolean>
  working: Accessor<boolean>
  blank: Accessor<boolean>
  tip: Accessor<JSX.Element>
  mode: Accessor<"normal" | "shell">
  disabled: Accessor<boolean>
  excludeFromTab: Accessor<boolean>
  block: Accessor<SubmitBlock | null>
  onChooseModel: VoidFunction
  onOpenModels: VoidFunction
  sendLabel: string
  stopLabel: string
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
        onOpenModels={() => {
          dismiss()
          props.onOpenModels()
        }}
      />
    )
  }

  const stopping = () => props.busy() && props.blank()

  const label = () =>
    stopping()
      ? props.stopLabel
      : props.block()
        ? props.block()!.copy
        : props.sendLabel

  return (
    <Tooltip
      placement="top"
      inactive={!props.block() && !props.working() && props.blank()}
      forceOpen={flash() && actionable()}
      value={tipContent()}
    >
      <div class="relative">
        <IconButton
          data-action="prompt-submit"
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
      </div>
    </Tooltip>
  )
}
