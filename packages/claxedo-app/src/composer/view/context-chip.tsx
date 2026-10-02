import type { JSX } from "solid-js"
import { ClaxedoIconButton as IconButton } from "@/ui"

export const CONTEXT_CHIP_CLASS =
  "group shrink-0 flex flex-col rounded-md pl-2 pr-1 py-1 max-w-[200px] h-12 cursor-default transition-all shadow-xs-border hover:shadow-xs-border-hover"

export function ChipRemoveButton(props: { readonly label: string; readonly onRemove: () => void }): JSX.Element {
  return (
    <IconButton
      type="button"
      icon="close-small"
      variant="ghost"
      class="ml-auto shrink-0 size-3.5 text-text-weak hover:text-text-strong transition-all [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
      onClick={(event) => {
        event.stopPropagation()
        props.onRemove()
      }}
      aria-label={props.label}
    />
  )
}
