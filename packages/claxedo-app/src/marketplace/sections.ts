import type {
  MachineInstalled,
  MachineInstalledEntry,
  MachineInstalledHarness,
  MachineSkill,
  PluginCandidate,
  PluginSourceRecord,
} from "@/server"
import type { MarketplaceKey } from "./i18n"
import { isBuiltIn, isInstalled, matchesQuery, pluginStatus } from "./model"

export const ALL = "all"
export const PERSONAL = "personal"

export type DirectorySection = {
  readonly id: string
  readonly title: { readonly key: MarketplaceKey } | { readonly text: string }
  readonly note?: MarketplaceKey
  readonly plugins: readonly PluginCandidate[]
}

export const PLUGIN_CATEGORIES: readonly { readonly id: string; readonly key: MarketplaceKey }[] = [
  { id: "skills", key: "marketplace.category.skills" },
  { id: "mcp-servers", key: "marketplace.category.mcpServers" },
  { id: "infrastructure", key: "marketplace.category.infrastructure" },
  { id: "data-and-analytics", key: "marketplace.category.data" },
  { id: "productivity", key: "marketplace.category.productivity" },
  { id: "agent-orchestration", key: "marketplace.category.orchestration" },
]

export type PluginCategoryView = { readonly id: string; readonly key: MarketplaceKey; readonly count: number }

export function inCategory(plugin: PluginCandidate, category: string) {
  return category === ALL || (plugin.categories ?? []).includes(category)
}

export function categoryChips(candidates: readonly PluginCandidate[]): PluginCategoryView[] {
  return PLUGIN_CATEGORIES.flatMap((category) => {
    const count = candidates.filter((plugin) => (plugin.categories ?? []).includes(category.id)).length
    return count > 0 ? [{ id: category.id, key: category.key, count }] : []
  })
}

export type PersonalPlugin = MachineInstalledEntry & {
  readonly kind: "plugin"
  readonly harnessId: MachineInstalledHarness["harnessId"]
}

export type PersonalSkill = MachineSkill & { readonly kind: "skill" }

export type PersonalEntry = PersonalPlugin | PersonalSkill

export type DirectorySourceView = Pick<PluginSourceRecord, "id" | "label">

export function sourcesFromCandidates(candidates: readonly PluginCandidate[]): DirectorySourceView[] {
  const seen = new Map<string, DirectorySourceView>()
  for (const candidate of candidates) {
    const source = candidate.source
    if (!source || seen.has(source.id)) continue
    seen.set(source.id, { id: source.id, label: source.label })
  }
  return [...seen.values()]
}

type SectionInput = {
  readonly candidates: readonly PluginCandidate[]
  readonly sources: readonly DirectorySourceView[]
  readonly query: string
  readonly filter: string
  readonly category?: string
}

function partition(visible: readonly PluginCandidate[]) {
  const attention: PluginCandidate[] = []
  const installed: PluginCandidate[] = []
  const offered: PluginCandidate[] = []
  for (const plugin of visible) {
    if (!isInstalled(plugin) && !isBuiltIn(plugin)) offered.push(plugin)
    else if (pluginStatus(plugin)?.attention) attention.push(plugin)
    else installed.push(plugin)
  }
  return { attention, installed, offered }
}

function offerSections(offered: readonly PluginCandidate[], input: SectionInput, category: string): DirectorySection[] {
  const sections: DirectorySection[] = []
  const featured = category === ALL ? offered.filter((plugin) => plugin.featured === true) : []
  if (featured.length > 0) {
    const note = "marketplace.section.featuredNote"
    sections.push({ id: "featured", title: { key: "marketplace.section.featured" }, note, plugins: featured })
  }
  const featuredIds = new Set(featured.map((plugin) => plugin.pluginInstanceId))
  const rest = offered.filter((plugin) => !featuredIds.has(plugin.pluginInstanceId))
  for (const source of input.sources) {
    const plugins = rest.filter((plugin) => plugin.source?.id === source.id)
    if (plugins.length > 0) sections.push({ id: `source:${source.id}`, title: { text: source.label }, plugins })
  }
  const known = new Set(input.sources.map((source) => source.id))
  const orphans = rest.filter((plugin) => !plugin.source || !known.has(plugin.source.id))
  if (orphans.length > 0)
    sections.push({ id: "source:unknown", title: { key: "marketplace.section.unserved" }, plugins: orphans })
  return sections
}

export function directorySections(input: SectionInput): DirectorySection[] {
  if (input.filter === PERSONAL) return []
  const query = input.query.trim().toLowerCase()
  const category = input.category ?? ALL
  const visible = input.candidates.filter(
    (plugin) =>
      matchesQuery(plugin, query) &&
      inCategory(plugin, category) &&
      (input.filter === ALL || plugin.source?.id === input.filter),
  )
  const { attention, installed, offered } = partition(visible)
  const sections: DirectorySection[] = []
  if (attention.length > 0)
    sections.push({ id: "needs-attention", title: { key: "marketplace.section.attention" }, plugins: attention })
  if (installed.length > 0)
    sections.push({ id: "installed", title: { key: "marketplace.section.installed" }, plugins: installed })
  return [...sections, ...offerSections(offered, input, category)]
}

export function personalEntries(input: {
  readonly machine: MachineInstalled | undefined
  readonly query: string
  readonly filter: string
  readonly category?: string
}): PersonalEntry[] {
  if (input.filter !== ALL && input.filter !== PERSONAL) return []
  if (input.category !== undefined && input.category !== ALL) return []
  const query = input.query.trim().toLowerCase()
  const plugins: PersonalEntry[] = (input.machine?.harnesses ?? []).flatMap((harness) =>
    harness.entries
      .filter((entry) => !entry.ownedByClaxedo && entry.name.toLowerCase().includes(query))
      .map((entry) => ({ ...entry, kind: "plugin" as const, harnessId: harness.harnessId })),
  )
  const skills: PersonalEntry[] = (input.machine?.skills ?? [])
    .filter((skill) => skill.name.toLowerCase().includes(query))
    .map((skill) => ({ ...skill, kind: "skill" as const }))
  return [...plugins, ...skills]
}

export function personalEntryKey(entry: PersonalEntry) {
  const marketplace = entry.kind === "plugin" ? (entry.marketplace ?? "") : ""
  return `${entry.kind}:${entry.harnessId}:${marketplace}:${entry.name}`
}
