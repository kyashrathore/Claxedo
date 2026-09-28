import { Component, For, Match, Show, Switch } from "solid-js"
import type { RuntimeCommand } from "@claxedo/agent-runtime-contract"
import type { ComposerTextKey } from "../i18n"
import { AtOptionRow } from "./at-option-row"
import { SlashCommandRow } from "./slash-command-row"

export type AtOption =
  | { type: "agent"; name: string; display: string }
  | { type: "file"; path: string; display: string; recent?: boolean }
  | {
      type: "document"
      documentId: string
      display: string
      originKind: "managed" | "repository"
      placementKind: "local" | "hosted"
      status: string
    }

type SlashCommandFields = {
  id: string
  trigger: string
  title: string
  description?: string
  keybind?: string
  source?: RuntimeCommand["source"]
}

export type SlashCommand =
  | (SlashCommandFields & { type: "builtin" })
  | (SlashCommandFields & { type: "custom" } & ({ origin: "saved"; content: string } | { origin: "transport" }))

export const PROMPT_POPOVER_LISTBOX_ID = "prompt-popover-listbox"

export const promptAtOptionId = (key: string) => `prompt-at-option-${key}`
export const promptSlashOptionId = (id: string) => `prompt-slash-option-${id}`

type PromptPopoverProps = {
  popover: "at" | "slash" | null
  documentPicker: boolean
  documentNotice?: string
  setSlashPopoverRef: (el: HTMLDivElement) => void
  atFlat: AtOption[]
  atActive?: string
  atKey: (item: AtOption) => string
  setAtActive: (id: string) => void
  onAtSelect: (item: AtOption) => void
  slashFlat: SlashCommand[]
  slashActive?: string
  setSlashActive: (id: string) => void
  onSlashSelect: (item: SlashCommand) => void
  commandKeybind: (id: string) => string | undefined
  t: (key: ComposerTextKey) => string
}

export const PromptPopover: Component<PromptPopoverProps> = (props) => {
  return (
    <Show when={props.popover}>
      <div
        data-surface="overlay"
        data-overlay-shell="prompt"
        ref={(el) => {
          if (props.popover === "slash") props.setSlashPopoverRef(el)
        }}
        role="listbox"
        id={PROMPT_POPOVER_LISTBOX_ID}
        aria-label={props.documentPicker ? "Documents" : props.t(props.popover === "at" ? "prompt.popover.atLabel" : "prompt.popover.slashLabel")}
        class="absolute inset-x-0 -top-2 -translate-y-full origin-bottom-left max-h-80 min-h-10
                 overflow-auto no-scrollbar flex flex-col p-2 bg-surface-raised-stronger-non-alpha"
        onMouseDown={(e) => e.preventDefault()}
      >
        <Switch>
          <Match when={props.popover === "at"}>
            <Show
              when={props.atFlat.length > 0}
              fallback={<div class="text-text-weak px-2 py-1">{props.documentPicker ? props.documentNotice ?? "No documents found." : props.t("prompt.popover.emptyResults")}</div>}
            >
              <For each={props.atFlat.slice(0, 10)}>
                {(item) => {
                  const key = props.atKey(item)
                  return (
                    <AtOptionRow
                      item={item}
                      id={promptAtOptionId(key)}
                      active={props.atActive === key}
                      onSelect={() => props.onAtSelect(item)}
                      onHover={() => props.setAtActive(key)}
                    />
                  )
                }}
              </For>
            </Show>
          </Match>
          <Match when={props.popover === "slash"}>
            <Show
              when={props.slashFlat.length > 0}
              fallback={<div class="text-text-weak px-2 py-1">{props.t("prompt.popover.emptyCommands")}</div>}
            >
              <For each={props.slashFlat}>
                {(cmd) => (
                  <SlashCommandRow
                    command={cmd}
                    id={promptSlashOptionId(cmd.id)}
                    active={props.slashActive === cmd.id}
                    keybind={props.commandKeybind(cmd.id)}
                    onSelect={() => props.onSlashSelect(cmd)}
                    onHover={() => props.setSlashActive(cmd.id)}
                    t={props.t}
                  />
                )}
              </For>
            </Show>
          </Match>
        </Switch>
      </div>
    </Show>
  )
}
