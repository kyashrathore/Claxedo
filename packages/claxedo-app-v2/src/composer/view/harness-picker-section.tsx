import { Show, type JSX } from "solid-js"
import { ClaxedoIcon as Icon } from "@/ui"

export type HarnessPickerSection = "harness" | "model"

export const HARNESS_PICKER_ROW_CLASS =
  "flex min-h-7 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1 text-left outline-none transition-colors duration-150 hover:bg-surface-base-hover focus-visible:bg-surface-base-hover"

export function SectionHeader(props: {
  label: string
  value: string
  expanded: boolean
  loading?: boolean
  disabled?: boolean
  hint?: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      data-expanded={props.expanded ? "true" : undefined}
      disabled={props.disabled || props.loading}
      aria-busy={props.loading}
      aria-expanded={props.expanded}
      title={props.hint}
      class={`shrink-0 disabled:pointer-events-none disabled:opacity-45 ${HARNESS_PICKER_ROW_CLASS}`}
      onClick={props.onToggle}
    >
      <Icon
        name="chevron-right"
        size="small"
        class={`shrink-0 text-icon-base transition-transform duration-200 ease-out${props.expanded ? " rotate-90" : ""}`}
      />
      <span class="shrink-0 text-compact font-medium text-text-base">{props.label}</span>
      <span class="flex min-w-0 flex-1 items-center justify-end gap-1.5">
        <Show when={props.loading}>
          <span
            aria-hidden="true"
            class="size-3 shrink-0 animate-spin rounded-full border border-border-base border-t-transparent"
          />
        </Show>
        <span
          class="min-w-0 truncate text-right text-compact transition-colors duration-150"
          classList={{
            "text-text-weak": !props.expanded && !props.loading,
            "text-text-weaker": props.expanded || props.loading,
          }}
        >
          {props.loading ? "Loading…" : props.value}
        </span>
      </span>
    </button>
  )
}

export function SectionPanel(props: { class?: string; children: JSX.Element }) {
  return (
    <div class={`harness-picker-panel ${props.class ?? ""}`}>
      {props.children}
    </div>
  )
}
