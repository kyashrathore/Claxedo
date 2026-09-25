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
import type { AtOption, SlashCommand } from "./slash-popover"

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
  input?: { hint: string } | null
  source?: SlashCommand["source"]
}

export function promptAtOptionKey(x: AtOption | undefined) {
  if (!x) return ""
  if (x.type === "agent") return `agent:${x.name}`
  if (x.type === "document") return `document:${x.documentId}`
  return `file:${x.path}`
}

const SLASH_ORDER = ["goal", "new", "open", "steps", "model", "mcp", "agent", "undo", "redo", "compact", "fork"]

const slashRank = (trigger: string) => {
  const rank = SLASH_ORDER.indexOf(trigger)
  return rank === -1 ? SLASH_ORDER.length : rank
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
    .sort((a, b) => slashRank(a.trigger) - slashRank(b.trigger))

  const goalReserved = builtin.some((command) => command.trigger.toLowerCase() === "goal")
  const custom = (input.customCommands ?? []).filter((cmd) => !(goalReserved && cmd.name.toLowerCase() === "goal")).map((cmd) => ({
    id: `custom.${cmd.name}`,
    trigger: cmd.name,
    title: cmd.name,
    description: cmd.input?.hint ? [cmd.description, cmd.input.hint].filter(Boolean).join(" · ") : cmd.description,
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

