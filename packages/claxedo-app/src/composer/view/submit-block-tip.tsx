import { Show } from "solid-js"
import type { SubmitBlock } from "../submit-block-reason"

export function SubmitBlockTip(props: { block: SubmitBlock; onChooseModel: VoidFunction }) {
  return (
    <div class="flex items-center gap-2">
      <span>{props.block.copy}</span>
      <Show when={props.block.reason === "no-model"}>
        <button
          type="button"
          data-action="prompt-block-model"
          class="rounded border border-border-base px-1.5 py-0.5 text-11-medium text-text-base transition-colors duration-150 hover:bg-surface-raised-base"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            props.onChooseModel()
          }}
        >
          Choose model
        </button>
      </Show>
    </div>
  )
}
