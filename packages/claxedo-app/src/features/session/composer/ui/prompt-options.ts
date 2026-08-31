// The pure option builders behind the composer's `@` and `/` popovers: given raw
// agents, commands and documents, produce the lists a popover renders, plus the
// grouping/ordering/active-row helpers that go with them.
//
// Deliberately separate from `popover-controller.ts`, which owns the LEGACY
// reactive controller. Both composer engines — the legacy one and the v2
// controller path — build their option lists from these functions, so the two
// produce byte-identical lists. Keeping them here is what lets the legacy
// controller be deleted without taking the shared builders with it.
//
// Nothing in this file is reactive: no Solid imports, no signals. That is the
// point — it is all data in, data out, which is why it can be shared and tested
// directly.
import type { AtOption, SlashCommand } from "@/features/session/composer/ui/slash-popover"

export type PromptAgentRow = {
  name: string
  hidden?: boolean
  mode?: string
}

export type PromptCommandOption = {
  id: string
  title: string
  description?: string
  keybind?: string
  slash?: string
  disabled?: boolean
}

export type PromptCustomCommand = {
  name: string
  description?: string
  source?: SlashCommand["source"]
}

export function promptAtOptionKey(x: AtOption | undefined) {
  if (!x) return ""
  if (x.type === "agent") return `agent:${x.name}`
  if (x.type === "document") return `document:${x.documentId}`
  return `file:${x.path}`
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
  if (item.type === "document") return "document"
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

  const goalReserved = builtin.some((command) => command.trigger.toLowerCase() === "goal")
  const custom = (input.customCommands ?? []).filter((cmd) => !(goalReserved && cmd.name.toLowerCase() === "goal")).map((cmd) => ({
    id: `custom.${cmd.name}`,
    trigger: cmd.name,
    title: cmd.name,
    description: cmd.description,
    type: "custom" as const,
    source: cmd.source,
  }))

  return [
    {
      id: "documents.open",
      trigger: "docs",
      title: "Documents",
      description: "Attach a document as an editable file",
      type: "builtin" as const,
    },
    ...custom,
    ...builtin,
  ]
}

export function promptDocumentOptions(
  documents: ReadonlyArray<{
    documentId: string
    displayName: string
    originKind: "managed" | "repository"
    placementKind: "local" | "hosted"
    status: string
  }>,
): AtOption[] {
  return documents.map((document) => ({
    type: "document",
    documentId: document.documentId,
    display: document.displayName,
    originKind: document.originKind,
    placementKind: document.placementKind,
    status: document.status,
  }))
}

export function activeAtOption(input: { items: AtOption[]; active?: string }) {
  if (input.items.length === 0) return
  return input.items.find((entry) => promptAtOptionKey(entry) === input.active) ?? input.items[0]
}

export function activeSlashCommand(input: { items: SlashCommand[]; active?: string }) {
  if (input.items.length === 0) return
  return input.items.find((entry) => entry.id === input.active) ?? input.items[0]
}

function promptAtGroupRank(category: string) {
  if (category === "document") return 0
  if (category === "agent") return 0
  if (category === "recent") return 1
  return 2
}
