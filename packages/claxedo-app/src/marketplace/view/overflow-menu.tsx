import type { JSX } from "solid-js"
import { DropdownMenu, Icon } from "@/ui"
import { GHOST_ICON_BUTTON } from "./chrome"

export function OverflowMenu(props: { readonly label: string; readonly children: JSX.Element }): JSX.Element {
  return (
    <DropdownMenu placement="bottom-end" gutter={4}>
      <DropdownMenu.Trigger aria-label={props.label} title={props.label} class={`${GHOST_ICON_BUTTON} size-6`}>
        <Icon name="three-dots" size="small" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="max-w-72">{props.children}</DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

export function OverflowItem(props: {
  readonly onSelect: () => void
  readonly disabled?: boolean
  readonly hint?: string
  readonly children: JSX.Element
}): JSX.Element {
  return (
    <DropdownMenu.Item disabled={props.disabled} onSelect={() => props.onSelect()}>
      <span class="flex min-w-0 flex-col gap-0.5 whitespace-normal" classList={{ "py-1.5": !!props.hint }}>
        <span class="text-13-regular text-text-strong">{props.children}</span>
        {props.hint ? <span class="text-12-regular leading-4 text-text-weak">{props.hint}</span> : null}
      </span>
    </DropdownMenu.Item>
  )
}
