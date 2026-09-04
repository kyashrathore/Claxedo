import { oauthServers, type OAuthServer } from "../connections"
export { oauthServers, type OAuthServer }
import { AGENT_PLUGIN_HARNESSES, type AgentPluginHarness, type PluginCandidate } from "../api"
import type { AgentPluginConnectionSummary } from "../connections"
import type { DirectorySource, MachineInstalled, MachineInstalledEntry } from "./data"

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

/** The plugin's artifact cannot be materialized, whatever activation says. */
export function artifactUnavailable(plugin: PluginCandidate) {
  return plugin.artifactAvailable === false
    || Boolean(plugin.artifactError)
    || AGENT_PLUGIN_HARNESSES.some((harness) => plugin.harnesses[harness].effective.status === "artifact-unavailable")
}


/** The MCP servers whose authentication is a Claxedo connection. */

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

export type DirectoryStateChip = {
  label: string
  tone: "ok" | "warning" | "critical"
  /** Attention chips move the card into the first section. */
  attention: boolean
}

/**
 * The one chip a card and the detail pane both show.
 *
 * Only installed plugins carry a state: the rest are offers, and an offer has
 * no runtime condition to report. Connection facts are read from the same list
 * the pane's per-server rows use, so a card never claims a state the pane
 * contradicts.
 */
export function stateChip(input: {
  plugin: PluginCandidate
  connections?: readonly AgentPluginConnectionSummary[]
}): DirectoryStateChip | undefined {
  const { plugin } = input
  if (!isInstalled(plugin)) {
    return plugin.updateAvailable ? { label: "Update available", tone: "warning", attention: false } : undefined
  }
  if (artifactUnavailable(plugin)) return { label: "Artifact unavailable", tone: "critical", attention: true }
  for (const server of oauthServers(plugin)) {
    const connection = effectiveConnection(input.connections, server.integrationId)
    if (!connection) return { label: "Needs authentication", tone: "warning", attention: true }
    if (connection.status === "broken") return { label: "Missing credential", tone: "critical", attention: true }
    if (connection.status === "degraded") return { label: "Needs reconnection", tone: "warning", attention: true }
  }
  if (plugin.updateAvailable) return { label: "Update available", tone: "warning", attention: false }
  const count = installedHarnesses(plugin).length
  return { label: `Installed on ${count} ${count === 1 ? "harness" : "harnesses"}`, tone: "ok", attention: false }
}

/** Search covers what a user would type: the plugin, its skills, its servers. */
export function matchesQuery(plugin: PluginCandidate, query: string) {
  if (!query) return true
  const haystack = [
    pluginLabel(plugin),
    plugin.manifest?.description ?? "",
    ...plugin.skills.map((skill) => skill.name),
    ...plugin.mcpServers.map((server) => server.name),
  ].join(" ").toLowerCase()
  return haystack.includes(query)
}

export type DirectorySection = {
  id: string
  title: string
  subtitle?: string
  plugins: PluginCandidate[]
}

export type PersonalEntry = MachineInstalledEntry & { harnessId: MachineInstalled["harnesses"][number]["harnessId"] }

/** What a section needs from a source; the full row carries removal state too. */
export type DirectorySourceView = Pick<DirectorySource, "id" | "kind" | "label" | "repository">

/** The sources a candidate list came from, in first-seen order. */
export function sourcesFromCandidates(candidates: readonly PluginCandidate[]): DirectorySourceView[] {
  const seen = new Map<string, DirectorySourceView>()
  for (const candidate of candidates) {
    const source = candidate.source
    if (!source || seen.has(source.id)) continue
    seen.set(source.id, {
      id: source.id,
      kind: source.kind,
      label: source.label,
      repository: source.repository ?? "",
    })
  }
  return [...seen.values()]
}

/**
 * Every section the Directory renders, in the order the user reads them:
 * what is broken, what is installed, what each source offers, and finally what
 * the user installed themselves in another harness.
 *
 * `filter` is the source chip: a source id narrows to that source (and drops
 * Personal), `"personal"` shows Personal alone, `"all"` shows everything.
 */
export function directorySections(input: {
  candidates: readonly PluginCandidate[]
  sources: readonly DirectorySourceView[]
  connections?: readonly AgentPluginConnectionSummary[]
  query: string
  filter: string
}): DirectorySection[] {
  const query = input.query.trim().toLowerCase()
  if (input.filter === "personal") return []
  const visible = input.candidates.filter((plugin) => matchesQuery(plugin, query)
    && (input.filter === "all" || plugin.source?.id === input.filter))
  const attention: PluginCandidate[] = []
  const installed: PluginCandidate[] = []
  const offered: PluginCandidate[] = []
  for (const plugin of visible) {
    if (!isInstalled(plugin)) {
      offered.push(plugin)
      continue
    }
    const chip = stateChip({ plugin, ...(input.connections ? { connections: input.connections } : {}) })
    if (chip?.attention) attention.push(plugin)
    else installed.push(plugin)
  }
  const sections: DirectorySection[] = []
  if (attention.length > 0) {
    sections.push({ id: "needs-attention", title: "Needs attention", plugins: attention })
  }
  if (installed.length > 0) sections.push({ id: "installed", title: "Installed", plugins: installed })
  for (const source of input.sources) {
    const plugins = offered.filter((plugin) => plugin.source?.id === source.id)
    if (plugins.length === 0) continue
    sections.push({
      id: `source:${source.id}`,
      title: source.label,
      subtitle: source.kind === "claxedo" ? source.repository : `added by you · ${source.repository}`,
      plugins,
    })
  }
  const known = new Set(input.sources.map((source) => source.id))
  const orphans = offered.filter((plugin) => !plugin.source || !known.has(plugin.source.id))
  if (orphans.length > 0) {
    sections.push({ id: "source:unknown", title: "Other", subtitle: "no longer served by a source", plugins: orphans })
  }
  return sections
}

/** The Personal section's rows: what other harnesses installed, minus our own. */
export function personalEntries(input: {
  machine: MachineInstalled | undefined
  query: string
  filter: string
}): PersonalEntry[] {
  if (input.filter !== "all" && input.filter !== "personal") return []
  const query = input.query.trim().toLowerCase()
  return (input.machine?.harnesses ?? []).flatMap((harness) => harness.entries
    .filter((entry) => !entry.ownedByClaxedo && entry.name.toLowerCase().includes(query))
    .map((entry) => ({ ...entry, harnessId: harness.harnessId })))
}
