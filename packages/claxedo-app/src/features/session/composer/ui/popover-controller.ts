// The LEGACY reactive controller for the composer's `@` and `/` popovers.
//
// Scheduled for deletion once the v2 controller path becomes the only engine
// (plan 2026-07-25-005, W5.2). The shared, non-reactive option builders it uses
// deliberately live in `prompt-options.ts` instead of here, so that deletion does
// not have to take them with it — both engines build their option lists from the
// same functions, which is what keeps the two paths producing identical lists.
import { createEffect, createMemo, type Accessor } from "solid-js"
import { useFilteredList } from "@opencode-ai/ui/hooks"
import type { AtOption, SlashCommand } from "@/features/session/composer/ui/slash-popover"
import {
  activeAtOption,
  activeSlashCommand,
  comparePromptAtGroups,
  promptAgentOptions,
  promptAtOptionGroup,
  promptAtOptionKey,
  promptAtOptions,
  promptDocumentOptions,
  promptSlashCommands,
  type PromptAgentRow,
  type PromptCommandOption,
  type PromptCustomCommand,
} from "@/features/session/composer/ui/prompt-options"

export function createPromptPopoverController(props: {
  popover: Accessor<"at" | "slash" | null>
  agents: Accessor<PromptAgentRow[]>
  recentFiles: Accessor<string[]>
  searchFilesAndDirectories: (query: string) => Promise<string[]>
  commandOptions: Accessor<PromptCommandOption[]>
  customCommands: Accessor<PromptCustomCommand[] | undefined>
  documentPicker: Accessor<boolean>
  documents: Accessor<Parameters<typeof promptDocumentOptions>[0]>
  onAtSelect: (option: AtOption | undefined) => void
  onSlashSelect: (command: SlashCommand | undefined) => void
}) {
  let slashPopoverRef: HTMLDivElement | undefined
  const agentOptions = createMemo(() => promptAgentOptions(props.agents()))
  const slashCommands = createMemo(() =>
    promptSlashCommands({
      commandOptions: props.commandOptions(),
      customCommands: props.customCommands(),
    }),
  )

  const atList = useFilteredList<AtOption>({
    items: (query) =>
      props.documentPicker()
        ? promptDocumentOptions(props.documents())
        : promptAtOptions({
            agents: agentOptions(),
            recentFiles: props.recentFiles(),
            query,
            searchFilesAndDirectories: props.searchFilesAndDirectories,
          }),
    key: promptAtOptionKey,
    filterKeys: ["display"],
    groupBy: promptAtOptionGroup,
    sortGroupsBy: comparePromptAtGroups,
    onSelect: props.onAtSelect,
  })

  const slashList = useFilteredList<SlashCommand>({
    items: slashCommands,
    key: (x) => x?.id,
    filterKeys: ["trigger", "title"],
    onSelect: props.onSlashSelect,
  })

  createEffect(() => {
    const activeId = slashList.active()
    if (!activeId || !slashPopoverRef) return

    requestAnimationFrame(() => {
      const element = slashPopoverRef?.querySelector(`[data-slash-id="${activeId}"]`)
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  })

  return {
    atFlat: atList.flat,
    atActive: atList.active,
    setAtActive: atList.setActive,
    atOnInput: atList.onInput,
    atOnKeyDown: atList.onKeyDown,
    atKey: promptAtOptionKey,
    handleAtSelect: props.onAtSelect,
    slashFlat: slashList.flat,
    slashActive: slashList.active,
    setSlashActive: slashList.setActive,
    slashOnInput: slashList.onInput,
    slashOnKeyDown: slashList.onKeyDown,
    handleSlashSelect: props.onSlashSelect,
    setSlashPopoverRef: (el: HTMLDivElement) => {
      slashPopoverRef = el
    },
    selectPopoverActive: () => {
      if (props.popover() === "at") {
        props.onAtSelect(activeAtOption({ items: atList.flat(), active: atList.active() ?? undefined }))
        return
      }
      if (props.popover() === "slash") {
        props.onSlashSelect(activeSlashCommand({ items: slashList.flat(), active: slashList.active() ?? undefined }))
      }
    },
  }
}
