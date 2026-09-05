import type { JSX } from "solid-js"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { GHOST_ICON_BUTTON } from "./chrome"

/**
 * The "…" menu every Agent Plugins surface hangs its secondary actions off.
 *
 * One owner, because the pane and each MCP row must agree on what a secondary
 * action looks like: a trigger that is only ever an icon, and items that read
 * as sentences rather than as buttons.
 */
export function OverflowMenu(props: { label: string; children: JSX.Element }) {
  return (
    <DropdownMenu placement="bottom-end" gutter={4}>
      <DropdownMenu.Trigger
        aria-label={props.label}
        title={props.label}
        class={`${GHOST_ICON_BUTTON} size-6`}
      >
        <Icon name="more-horizontal" size="small" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        {/* Bounded and end-aligned under its trigger: an unbounded menu grew to
            the width of its longest sentence and ran out of the pane. */}
        <DropdownMenu.Content class="max-w-72">{props.children}</DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

export function OverflowItem(props: { onSelect: () => void; disabled?: boolean; hint?: string; children: JSX.Element }) {
  return (
    <DropdownMenu.Item disabled={props.disabled} onSelect={() => props.onSelect()} class="flex-col items-start gap-0.5 whitespace-normal">
      <span class="text-13-regular text-text-strong">{props.children}</span>
      {props.hint ? <span class="text-12-regular text-text-weak">{props.hint}</span> : null}
    </DropdownMenu.Item>
  )
}
