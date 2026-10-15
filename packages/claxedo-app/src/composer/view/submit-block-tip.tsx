import { Show } from "solid-js"
import type { SubmitBlock } from "../submit-block-reason"

const BUTTON = "rounded border border-border-base px-1.5 py-0.5 text-11-medium text-text-base transition-colors duration-150 hover:bg-surface-raised-base"

export function SubmitBlockTip(props: { block: SubmitBlock; onChooseModel: VoidFunction; onOpenModels: VoidFunction }) {
  const run = (action: VoidFunction) => (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    action()
  }
  return (
    <div class="flex items-center gap-2">
      <span>{props.block.copy}</span>
      <Show when={props.block.action === "choose-model"}>
        <button type="button" data-action="prompt-block-model" class={BUTTON} onClick={run(props.onChooseModel)}>
          Choose model
        </button>
      </Show>
      <Show when={props.block.action === "open-models"}>
        <button type="button" data-action="prompt-block-models" aria-label="Open Settings Models" class={BUTTON} onClick={run(props.onOpenModels)}>
          Open Models
        </button>
      </Show>
    </div>
  )
}
