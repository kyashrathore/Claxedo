import { Show } from "solid-js"
import type { ComposerTextKey } from "../i18n"
import type { SlashCommand } from "./slash-popover"

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
        <Show when={props.command.type === "custom" && props.command.source !== "command"}>
          <span class="text-11-regular text-text-weak px-1.5 py-0.5 bg-surface-base rounded">
            {props.command.source === "skill"
              ? props.t("prompt.slash.badge.skill")
              : props.command.source === "mcp"
                ? props.t("prompt.slash.badge.mcp")
                : props.t("prompt.slash.badge.custom")}
          </span>
        </Show>
        <Show when={props.keybind}>
          <span class="text-12-regular text-text-weak">{props.keybind}</span>
        </Show>
      </div>
    </button>
  )
}
