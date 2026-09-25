import { Show, type JSX } from "solid-js"
import { ClaxedoIcon as Icon } from "@/ui"
import { HARNESS_PICKER_ROW_CLASS } from "./harness-picker-section"

export function OptionRow(props: { selected: boolean; icon?: JSX.Element; label: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-current={props.selected ? "true" : undefined}
      class={`text-compact ${HARNESS_PICKER_ROW_CLASS}`}
      onClick={props.onSelect}
    >
      <Show when={props.icon}>
        <span class="flex shrink-0 items-center">{props.icon}</span>
      </Show>
      <span
        class="min-w-0 flex-1 truncate"
        classList={{ "text-text-base": props.selected, "text-text-weak": !props.selected }}
      >
        {props.label}
      </span>
      <Icon
        name="check"
        size="small"
        class="shrink-0 text-icon-base"
        classList={{ invisible: !props.selected }}
      />
    </button>
  )
}
