import { Index, Show, type JSX } from "solid-js"
import { ContextChipPicker } from "./context-chip-picker"

export type ContextChipAvatar = {
  fallback: string
  src?: string
}

export type ContextChipOption = {
  value: string
  label: string
  detail?: string
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
  ariaLabel: string
  options: ContextChipOption[]
  current?: string
  onSelect: (value: string) => void
  search?: { placeholder: string }
  groupLabel?: string
  emptyMessage: string
  action?: ContextChipAction
  panel?: {
    label: string
    render: (input: { close: () => void; back: () => void; hold: (active: boolean) => void }) => JSX.Element
  }
  openPanel?: { pending: () => boolean; answer: () => void }
  disabled?: boolean
}

export type ContextPin = {
  slot: string
  label: string
  detail: string
  compactDetail: string
}

export function SessionContextRow(props: { chips: ContextChip[]; pin?: ContextPin }) {
  return (
    <div
      data-component="session-context-row"
      data-claxedo-compact-touch
      class="flex min-w-0 items-center gap-0.5 overflow-hidden rounded-t-xl border border-b-0 border-v2-border-border-muted bg-v2-background-bg-deep px-1.5 pt-1 pb-3"
    >
      <Index each={props.chips}>{(chip) => <ContextChipPicker chip={chip()} />}</Index>
      <Show when={props.pin}>
        {(pin) => (
          <div data-self-hosted-pinned="true" data-slot={pin().slot} class="flex h-7 min-w-0 items-center gap-2 px-2">
            <span class="size-1.5 shrink-0 rounded-full bg-surface-success-strong" aria-hidden="true" />
            <span class="truncate text-compact font-body leading-4 text-v2-text-text-base">{pin().label}</span>
            <span data-slot="self-hosted-detail" class="shrink-0 text-12-medium text-v2-text-text-faint">
              {pin().detail}
            </span>
            <span data-slot="self-hosted-compact-detail" class="ui-self-hosted-compact-detail shrink-0 text-12-medium text-v2-text-text-faint">
              {pin().compactDetail}
            </span>
          </div>
        )}
      </Show>
    </div>
  )
}
