import { oauthServers, type OAuthServer } from "../connections"
export { oauthServers, type OAuthServer }
import {
  AGENT_PLUGIN_HARNESSES,
  BUILT_IN_TOOL_GROUP_ORDER,
  type AgentPluginHarness,
  type HarnessActivation,
  type PluginCandidate,
  type PluginToolGroup,
} from "../api"
import type { AgentPluginConnectionSummary } from "../connections"
import type { DirectorySource, MachineInstalled, MachineInstalledEntry, MachineInstalledHarness, MachineSkill } from "./data"

/** What a card is titled: the manifest name, else whatever identifies the artifact. */
export function pluginLabel(plugin: PluginCandidate) {
  return plugin.manifest?.name ?? plugin.relativePath ?? plugin.pluginInstanceId
}

/** The harnesses the plugin is effectively enabled on right now. */
export function installedHarnesses(plugin: PluginCandidate): AgentPluginHarness[] {
  return AGENT_PLUGIN_HARNESSES.filter((harness) => plugin.harnesses[harness].effective.effective)
}

/** "Installed" means at least one harness resolves the plugin as enabled. */
export function isInstalled(plugin: PluginCandidate) {
  return installedHarnesses(plugin).length > 0
}

/** The first-party server, which ships with the product rather than from a source. */
export function isBuiltIn(plugin: PluginCandidate) {
  return plugin.builtIn === true
}

/**
 * The built-in's groups in reading order; the catalog emits them in
 * registration order. A group the order table does not name keeps its place
 * behind the ones it does, rather than jumping to the front on `indexOf`'s -1.
 */
export function toolGroups(plugin: PluginCandidate): PluginToolGroup[] {
  const rank = (group: PluginToolGroup) => {
    const index = BUILT_IN_TOOL_GROUP_ORDER.indexOf(group.id)
    return index === -1 ? BUILT_IN_TOOL_GROUP_ORDER.length : index
  }
  return [...plugin.groups ?? []].sort((left, right) => rank(left) - rank(right))
}

/** The tool groups the built-in registers on a session started now. */
export function enabledToolGroups(plugin: PluginCandidate): string[] {
  return toolGroups(plugin).filter((group) => group.enabled).map((group) => group.id)
}

/** The plugin's artifact cannot be materialized, whatever activation says. */
export function artifactUnavailable(plugin: PluginCandidate) {
  return plugin.artifactAvailable === false
    || Boolean(plugin.artifactError)
    || AGENT_PLUGIN_HARNESSES.some((harness) => plugin.harnesses[harness].effective.status === "artifact-unavailable")
}

export function connectionFor(
  connections: readonly AgentPluginConnectionSummary[] | undefined,
  integrationId: string,
  scope: AgentPluginConnectionSummary["scope"],
) {
  return connections?.find((connection) => connection.integrationId === integrationId && connection.scope === scope)
}

/** A personal connection wins over the organization's, as the server resolves it. */
export function effectiveConnection(
  connections: readonly AgentPluginConnectionSummary[] | undefined,
  integrationId: string,
) {
  return connectionFor(connections, integrationId, "personal") ?? connectionFor(connections, integrationId, "team")
}

export type PluginStatusTone = "normal" | "warning" | "critical" | "accent"

export type PluginStatus = {
  label: string
  tone: PluginStatusTone
  /** Attention states move the card into the first section. */
  attention: boolean
}

/**
 * The one status a card and the detail pane both report.
 *
 * Only installed plugins carry a status: the rest are offers, and an offer has
 * no runtime condition to report. Connection facts are read from the same list
 * the pane's per-server rows use, so a card never claims a status the pane
 * contradicts.
 */
export function pluginStatus(input: {
  plugin: PluginCandidate
  connections?: readonly AgentPluginConnectionSummary[]
  /** False while the connection list could not be read: an unknown status is not "needs authentication". */
  connectionsKnown?: boolean
}): PluginStatus | undefined {
  const { plugin } = input
  if (isBuiltIn(plugin)) {
    if (!isInstalled(plugin)) return { label: "Off for this project", tone: "normal", attention: false }
    const groups = enabledToolGroups(plugin)
    return groups.length > 0
      ? { label: `On for this project: ${groups.join(", ")}`, tone: "normal", attention: false }
      : { label: "No tool groups on for this project", tone: "warning", attention: false }
  }
  if (!isInstalled(plugin)) {
    return plugin.updateAvailable ? { label: "Update available", tone: "accent", attention: false } : undefined
  }
  if (artifactUnavailable(plugin)) return { label: "Artifact unavailable", tone: "critical", attention: true }
  for (const server of input.connectionsKnown === false ? [] : oauthServers(plugin)) {
    const connection = effectiveConnection(input.connections, server.integrationId)
    if (!connection) return { label: "Needs authentication", tone: "warning", attention: true }
    if (connection.status === "broken") return { label: "Missing credential", tone: "critical", attention: true }
    if (connection.status === "degraded") return { label: "Needs reconnection", tone: "warning", attention: true }
  }
  if (plugin.updateAvailable) return { label: "Update available", tone: "accent", attention: false }
  const count = installedHarnesses(plugin).length
  return { label: `Installed \u00b7 ${count} ${count === 1 ? "harness" : "harnesses"}`, tone: "normal", attention: false }
}

/** Whether any authority has spoken about this harness at all. */
function decided(state: HarnessActivation) {
  return state.explicit !== undefined && state.explicit !== null
    || state.projectOverride !== undefined && state.projectOverride !== null
    || state.userDefault !== undefined && state.userDefault !== null
    || state.organizationDefault !== undefined
    || state.claxedoDefault !== undefined
}

/** What `effective.winner` is called in the pane's facts strip. */
function authorityPhrase(winner: string) {
  switch (winner) {
    case "project":
    case "user-default":
      return "your choice"
    case "organization":
      return "organization default"
    case "claxedo":
      return "Claxedo default"
    case "machine":
      return "this computer"
    default:
      return "no default"
  }
}

/**
 * The Status fact: whether the plugin runs, and which authority decided it.
 *
 * The winner is read from the harness that actually resolves the plugin — the
 * first effective one, else the first one any authority has spoken about — so
 * the sentence names the authority the user would have to change.
 */
export function activationSummary(plugin: PluginCandidate): string {
  const installed = isInstalled(plugin)
  const harness = AGENT_PLUGIN_HARNESSES.find((id) => plugin.harnesses[id].effective.effective)
    ?? AGENT_PLUGIN_HARNESSES.find((id) => decided(plugin.harnesses[id]))
  if (!installed && !harness) return "Not installed"
  const winner = harness ? plugin.harnesses[harness].effective.winner : "none"
  return `${installed ? "Enabled" : "Disabled"} \u00b7 ${authorityPhrase(winner)}`
}

/**
 * What the plugin would resolve to once the user's own override is gone.
 *
 * Clearing an override hands the decision back to the organization when it has
 * one and to Claxedo otherwise, which is exactly the sentence the overflow menu
 * has to promise before it posts `choice: null`.
 */
export function defaultOutcome(input: {
  plugin: PluginCandidate
  harnesses: readonly AgentPluginHarness[]
}): { authority: "organization" | "Claxedo"; enabled: boolean } {
  const states = input.harnesses.map((harness) => input.plugin.harnesses[harness])
  return {
    authority: states.some((state) => state.organizationDefault !== undefined) ? "organization" : "Claxedo",
    enabled: states.some((state) => state.organizationDefault ?? state.claxedoDefault ?? false),
  }
}

/** Search covers what a user would type: the plugin, its skills, its servers. */
export function matchesQuery(plugin: PluginCandidate, query: string) {
  if (!query) return true
  const haystack = [
    pluginLabel(plugin),
    plugin.manifest?.description ?? "",
    ...plugin.skills.map((skill) => skill.name),
    ...plugin.mcpServers.map((server) => server.name),
    ...(plugin.groups ?? []).flatMap((group) => [group.id, ...group.tools]),
  ].join(" ").toLowerCase()
  return haystack.includes(query)
}

export type DirectorySection = {
  id: string
  title: string
  /** A word under the heading, for a section whose membership is not self-evident. */
  note?: string
  plugins: PluginCandidate[]
}

/**
 * The browse categories a plugin manifest may declare, in reading order.
 *
 * The ids come from the catalog; the labels are the Directory's, so a category
 * the server starts serving that this table does not name simply earns no chip
 * rather than a raw id.
 */
export const PLUGIN_CATEGORIES = [
  { id: "skills", label: "Skills" },
  { id: "mcp-servers", label: "MCP Servers" },
  { id: "infrastructure", label: "Infrastructure" },
  { id: "data-and-analytics", label: "Data & Analytics" },
  { id: "productivity", label: "Productivity" },
  { id: "agent-orchestration", label: "Agent Orchestration" },
] as const

export type PluginCategoryView = { id: string; label: string; count: number }

/** True when the plugin declares the category, or when no category is asked for. */
export function inCategory(plugin: PluginCandidate, category: string) {
  return category === "all" || (plugin.categories ?? []).includes(category)
}

/** The chips the catalog earns: a category no candidate declares has nothing to filter to. */
export function categoryChips(candidates: readonly PluginCandidate[]): PluginCategoryView[] {
  return PLUGIN_CATEGORIES.flatMap((category) => {
    const count = candidates.filter((plugin) => (plugin.categories ?? []).includes(category.id)).length
    return count > 0 ? [{ id: category.id, label: category.label, count }] : []
  })
}

/** A plugin another harness installed; Claxedo lists it and manages nothing about it. */
export type PersonalPlugin = MachineInstalledEntry & { kind: "plugin"; harnessId: MachineInstalledHarness["harnessId"] }

/** A `SKILL.md` folder found in a harness's machine-wide skills directory. */
export type PersonalSkill = MachineSkill & { kind: "skill" }

export type PersonalEntry = PersonalPlugin | PersonalSkill

/** What a section needs from a source; the full row carries kind and removal state too. */
export type DirectorySourceView = Pick<DirectorySource, "id" | "label">

/** The sources a candidate list came from, in first-seen order. */
export function sourcesFromCandidates(candidates: readonly PluginCandidate[]): DirectorySourceView[] {
  const seen = new Map<string, DirectorySourceView>()
  for (const candidate of candidates) {
    const source = candidate.source
    if (!source || seen.has(source.id)) continue
    seen.set(source.id, { id: source.id, label: source.label })
  }
  return [...seen.values()]
}

/**
 * Every section the Directory renders, in the order the user reads them:
 * what is broken, what is installed, what is worth starting with, what each
 * source offers, and finally what the user installed themselves in another
 * harness.
 *
 * `filter` is the source chip: a source id narrows to that source (and drops
 * Personal), `"personal"` shows Personal alone, `"all"` shows everything.
 * `category` is the second, independent axis: a category id keeps only the
 * plugins that declare it, and Featured — an unfiltered browse aid — steps
 * aside while one is chosen.
 */
export function directorySections(input: {
  candidates: readonly PluginCandidate[]
  sources: readonly DirectorySourceView[]
  connections?: readonly AgentPluginConnectionSummary[]
  connectionsKnown?: boolean
  query: string
  filter: string
  /** A category chip id, or `"all"`. */
  category?: string
}): DirectorySection[] {
  const query = input.query.trim().toLowerCase()
  if (input.filter === "personal") return []
  const category = input.category ?? "all"
  const visible = input.candidates.filter((plugin) => matchesQuery(plugin, query)
    && inCategory(plugin, category)
    && (input.filter === "all" || plugin.source?.id === input.filter))
  const attention: PluginCandidate[] = []
  const installed: PluginCandidate[] = []
  const offered: PluginCandidate[] = []
  for (const plugin of visible) {
    // The built-in is never an offer: it is always present, so a disabled one
    // belongs beside the installed plugins rather than in a source's section,
    // which it has none of.
    if (!isInstalled(plugin) && !isBuiltIn(plugin)) {
      offered.push(plugin)
      continue
    }
    const status = pluginStatus({ plugin, ...(input.connections ? { connections: input.connections } : {}), ...(input.connectionsKnown === false ? { connectionsKnown: false } : {}) })
    if (status?.attention) attention.push(plugin)
    else installed.push(plugin)
  }
  const sections: DirectorySection[] = []
  if (attention.length > 0) {
    sections.push({ id: "needs-attention", title: "Needs attention", plugins: attention })
  }
  if (installed.length > 0) sections.push({ id: "installed", title: "Installed", plugins: installed })
  // Only what is NOT installed can be featured: a featured card is an offer to
  // start with, and pulling an installed plugin up here would take it out of
  // the section that reports its runtime condition.
  const featured = category === "all" ? offered.filter((plugin) => plugin.featured === true) : []
  const featuredIds = new Set(featured.map((plugin) => plugin.pluginInstanceId))
  if (featured.length > 0) {
    sections.push({ id: "featured", title: "Featured", note: "Hand-picked to start with.", plugins: featured })
  }
  const rest = offered.filter((plugin) => !featuredIds.has(plugin.pluginInstanceId))
  for (const source of input.sources) {
    const plugins = rest.filter((plugin) => plugin.source?.id === source.id)
    if (plugins.length === 0) continue
    sections.push({ id: `source:${source.id}`, title: source.label, plugins })
  }
  const known = new Set(input.sources.map((source) => source.id))
  const orphans = rest.filter((plugin) => !plugin.source || !known.has(plugin.source.id))
  if (orphans.length > 0) {
    sections.push({ id: "source:unknown", title: "No longer served by a source", plugins: orphans })
  }
  return sections
}

/** The Personal section's rows: what other harnesses installed, minus our own. */
export function personalEntries(input: {
  machine: MachineInstalled | undefined
  query: string
  filter: string
  /** A category narrows the catalog only; nothing on this machine declares one. */
  category?: string
}): PersonalEntry[] {
  if (input.filter !== "all" && input.filter !== "personal") return []
  if (input.category !== undefined && input.category !== "all") return []
  const query = input.query.trim().toLowerCase()
  const plugins: PersonalEntry[] = (input.machine?.harnesses ?? []).flatMap((harness) => harness.entries
    .filter((entry) => !entry.ownedByClaxedo && entry.name.toLowerCase().includes(query))
    .map((entry) => ({ ...entry, kind: "plugin" as const, harnessId: harness.harnessId })))
  const skills: PersonalEntry[] = (input.machine?.skills ?? [])
    .filter((skill) => skill.name.toLowerCase().includes(query))
    .map((skill) => ({ ...skill, kind: "skill" as const }))
  return [...plugins, ...skills]
}

/**
 * The body of a SKILL.md: the YAML frontmatter (name, description, …) is
 * already shown as the skill's row, so the pane renders only what follows it.
 */
export function skillBody(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown)
  return (match ? markdown.slice(match[0].length) : markdown).replace(/^\s+/, "")
}
