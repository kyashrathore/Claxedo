import type { Accessor } from "solid-js"

export type CommandSource = "palette" | "keybind" | "slash"

export type CommandOption = {
  id: string
  title: string
  description?: string
  category?: string
  keybind?: string
  slash?: string
  suggested?: boolean
  disabled?: boolean
  hidden?: boolean
  onSelect?: (source?: CommandSource) => void
  onHighlight?: () => (() => void) | void
}

export type CommandOwner = { isVisible: () => boolean; isFocused: () => boolean }

export type CommandRegistration = {
  key?: string
  owner?: CommandOwner
  options: Accessor<CommandOption[]>
}

export const SUGGESTED_PREFIX = "suggested."

export function actionId(id: string): string {
  return id.startsWith(SUGGESTED_PREFIX) ? id.slice(SUGGESTED_PREFIX.length) : id
}

export function commandOwnerActive(owner: CommandOwner | undefined): boolean {
  return !owner || (owner.isVisible() && owner.isFocused())
}

export function upsertRegistration(registrations: CommandRegistration[], entry: CommandRegistration): CommandRegistration[] {
  if (entry.key === undefined) return [entry, ...registrations]
  return [entry, ...registrations.filter((x) => x.key !== entry.key || x.owner !== entry.owner)]
}

export type CommandProjection = {
  all: CommandOption[]
  ids: ReadonlySet<string>
  slash: CommandOption[]
}

export function projectRegistrations(
  registrations: readonly CommandRegistration[],
  onDuplicate: (id: string) => void,
): CommandProjection {
  const ids = new Set<string>()
  const all: CommandOption[] = []
  const slash: CommandOption[] = []
  for (const registration of registrations) {
    for (const option of registration.options()) {
      if (ids.has(option.id)) {
        onDuplicate(option.id)
        continue
      }
      ids.add(option.id)
      all.push(option)
      if (option.slash && !option.disabled && !option.id.startsWith(SUGGESTED_PREFIX)) slash.push(option)
    }
  }
  return { all, ids, slash }
}

export function indexOptions(options: readonly CommandOption[]): Map<string, CommandOption> {
  const index = new Map<string, CommandOption>()
  for (const option of options) {
    index.set(option.id, option)
    index.set(actionId(option.id), option)
  }
  return index
}

export function resolveEffectiveKeybind(custom: string | undefined, registeredDefault: string | undefined): string | undefined {
  const config = custom ?? registeredDefault
  if (!config || config === "none") return undefined
  return config
}

export function withSuggested(resolved: readonly CommandOption[], suggestedCategory: string): CommandOption[] {
  const suggested = resolved.filter((x) => x.suggested && !x.disabled)
  return [...suggested.map((x) => ({ ...x, id: SUGGESTED_PREFIX + x.id, category: suggestedCategory })), ...resolved]
}
