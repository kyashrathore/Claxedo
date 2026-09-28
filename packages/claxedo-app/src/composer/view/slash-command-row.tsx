import { Show } from "solid-js"
import type { ComposerTextKey } from "../i18n"
import type { SlashCommand } from "./slash-popover"

export function slashCommandBadge(command: SlashCommand): ComposerTextKey | undefined {
  if (command.type !== "custom") return undefined
  if (command.origin === "saved") return "prompt.slash.badge.saved"
  if (command.source === "command") return undefined
  if (command.source === "skill") return "prompt.slash.badge.skill"
  if (command.source === "mcp") return "prompt.slash.badge.mcp"
  return "prompt.slash.badge.custom"
}

export function SlashCommandRow(props: {
  command: SlashCommand
  id: string
  active: boolean
  keybind: string | undefined
  onSelect: () => void
  onHover: () => void
  t: (key: ComposerTextKey) => string
}) {
  return (
    <button
      data-slash-id={props.command.id}
      role="option"
      id={props.id}
      aria-selected={props.active}
      classList={{
        "w-full flex items-center justify-between gap-4 rounded-md px-2 py-1": true,
        "bg-surface-raised-base-hover": props.active,
      }}
      onClick={() => props.onSelect()}
      onMouseEnter={() => props.onHover()}
    >
      <div class="flex items-center gap-2 min-w-0">
        <span class="text-14-regular text-text-strong whitespace-nowrap">/{props.command.trigger}</span>
        <Show when={props.command.description}>
          <span class="text-14-regular text-text-weak truncate">{props.command.description}</span>
        </Show>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <Show when={slashCommandBadge(props.command)}>
          {(badge) => <span class="text-11-regular text-text-weak px-1.5 py-0.5 bg-surface-base rounded">{props.t(badge())}</span>}
        </Show>
        <Show when={props.keybind}>
          <span class="text-12-regular text-text-weak">{props.keybind}</span>
        </Show>
      </div>
    </button>
  )
}
