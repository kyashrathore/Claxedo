import { Index, type JSX } from "solid-js"
import { ContextChipPicker } from "./context-chip-picker"
import "./context-row.css"

export type ContextChipAvatar = {
  fallback: string
  src?: string
}

export type ContextChipOption = {
  value: string
  label: string
  detail?: string
  group?: string
  avatar?: ContextChipAvatar
}

export type ContextChipAction = {
  label: string
  onSelect: VoidFunction
}

export type ContextChip = {
  slot: string
  icon: JSX.Element
  avatar?: ContextChipAvatar
  label: string
  title?: string
  ariaLabel: string
  options: ContextChipOption[]
  current?: string
  onSelect: (value: string) => void
  search?: { placeholder: string }
  groupLabel?: string
  emptyMessage: string
  actions?: readonly ContextChipAction[]
  disabled?: boolean
}

export function SessionContextRow(props: { chips: ContextChip[] }) {
  return (
    <div
      data-claxedo-compact-touch
      class="session-context-row flex min-w-0 items-center gap-0.5 overflow-hidden rounded-t-xl border border-b-0 border-v2-border-border-muted bg-v2-background-bg-deep px-1.5 pt-1 pb-3"
    >
      <Index each={props.chips}>{(chip) => <ContextChipPicker chip={chip()} />}</Index>
    </div>
  )
}
