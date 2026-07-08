import { createEffect, createMemo, type Accessor } from "solid-js"
import { useFilteredList } from "@opencode-ai/ui/hooks"
import type { AtOption, SlashCommand } from "@/components/prompt-input/slash-popover"

type PromptAgentRow = {
  name: string
  hidden?: boolean
  mode?: string
}

type PromptCommandOption = {
  id: string
  title: string
  description?: string
  keybind?: string
  slash?: string
  disabled?: boolean
}

type PromptCustomCommand = {
  name: string
  description?: string
  source?: SlashCommand["source"]
}

export function promptAtOptionKey(x: AtOption | undefined) {
  if (!x) return ""
  return x.type === "agent" ? `agent:${x.name}` : `file:${x.path}`
}

export async function promptAtOptions(input: {
  agents: AtOption[]
  recentFiles: string[]
  query: string
  searchFilesAndDirectories: (query: string) => Promise<string[]>
}) {
  const seen = new Set(input.recentFiles)
  const pinned: AtOption[] = input.recentFiles.map((path) => ({ type: "file", path, display: path, recent: true }))
  if (!input.query.trim()) return [...input.agents, ...pinned]
  return [
    ...input.agents,
    ...pinned,
    ...(await input.searchFilesAndDirectories(input.query))
      .filter((path) => !seen.has(path))
      .map((path): AtOption => ({ type: "file", path, display: path })),
  ]
}

export function promptAtOptionGroup(item: AtOption) {
  if (item.type === "agent") return "agent"
  if (item.recent) return "recent"
  return "file"
}

export function comparePromptAtGroups(a: { category: string }, b: { category: string }) {
  return promptAtGroupRank(a.category) - promptAtGroupRank(b.category)
}

export function promptAgentOptions(agents: PromptAgentRow[]) {
  return agents
    .filter((agent) => !agent.hidden && agent.mode !== "primary")
    .map((agent): AtOption => ({ type: "agent", name: agent.name, display: agent.name }))
}

export function promptSlashCommands(input: {
  commandOptions: PromptCommandOption[]
  customCommands?: PromptCustomCommand[]
}) {
  const builtin = input.commandOptions
    .filter((opt) => !opt.disabled && !opt.id.startsWith("suggested.") && opt.slash)
    .map((opt) => ({
      id: opt.id,
      trigger: opt.slash!,
      title: opt.title,
      description: opt.description,
      keybind: opt.keybind,
      type: "builtin" as const,
    }))

  const custom = (input.customCommands ?? []).map((cmd) => ({
    id: `custom.${cmd.name}`,
    trigger: cmd.name,
    title: cmd.name,
    description: cmd.description,
    type: "custom" as const,
    source: cmd.source,
  }))

  return [...custom, ...builtin]
}

export function activeAtOption(input: {
  items: AtOption[]
  active?: string
}) {
  if (input.items.length === 0) return
  return input.items.find((entry) => promptAtOptionKey(entry) === input.active) ?? input.items[0]
}

export function activeSlashCommand(input: {
  items: SlashCommand[]
  active?: string
}) {
  if (input.items.length === 0) return
  return input.items.find((entry) => entry.id === input.active) ?? input.items[0]
}

export function createPromptPopoverController(props: {
  popover: Accessor<"at" | "slash" | null>
  agents: Accessor<PromptAgentRow[]>
  recentFiles: Accessor<string[]>
  searchFilesAndDirectories: (query: string) => Promise<string[]>
  commandOptions: Accessor<PromptCommandOption[]>
  customCommands: Accessor<PromptCustomCommand[] | undefined>
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
      promptAtOptions({
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

function promptAtGroupRank(category: string) {
  if (category === "agent") return 0
  if (category === "recent") return 1
  return 2
}
