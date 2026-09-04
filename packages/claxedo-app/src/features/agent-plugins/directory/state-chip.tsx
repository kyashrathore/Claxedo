import type { DirectoryStateChip } from "./view"

/** The single state word a card and the detail pane agree on. */
export function StateChip(props: { chip: DirectoryStateChip }) {
  return (
    <span
      data-component="agent-plugin-state"
      class="shrink-0 rounded-full border px-2 py-px text-11-medium whitespace-nowrap"
      classList={{
        "border-border-success-base text-icon-success-base": props.chip.tone === "ok",
        "border-border-warning-base text-icon-warning-base": props.chip.tone === "warning",
        "border-border-critical-base text-icon-critical-base": props.chip.tone === "critical",
      }}
    >
      {props.chip.label}
    </span>
  )
}
