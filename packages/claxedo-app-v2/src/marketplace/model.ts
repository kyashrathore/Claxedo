import {
  PLUGIN_HARNESSES,
  type PluginActivation,
  type PluginCandidate,
  type PluginHarness,
  type PluginToolGroup,
} from "@/server"
import { oauthServers } from "./connections"
import type { MarketplaceKey } from "./i18n"

export const BUILT_IN_TOOL_GROUP_ORDER: readonly string[] = [
  "sessions",
  "subagents",
  "attention",
  "processes",
  "documents",
  "tasks",
  "review",
  "workspaces",
]

export type Phrase = { readonly key: MarketplaceKey; readonly params?: Readonly<Record<string, string | number>> }

export function pluginLabel(plugin: PluginCandidate) {
  return plugin.manifest?.name ?? plugin.relativePath ?? plugin.pluginInstanceId
}

export function installedHarnesses(plugin: PluginCandidate): PluginHarness[] {
  return PLUGIN_HARNESSES.filter((harness) => plugin.harnesses[harness].effective.effective)
}

export function isInstalled(plugin: PluginCandidate) {
  return installedHarnesses(plugin).length > 0
}

export function isBuiltIn(plugin: PluginCandidate) {
  return plugin.builtIn === true
}

export function toolGroups(plugin: PluginCandidate): PluginToolGroup[] {
  const rank = (group: PluginToolGroup) => {
    const index = BUILT_IN_TOOL_GROUP_ORDER.indexOf(group.id)
    return index === -1 ? BUILT_IN_TOOL_GROUP_ORDER.length : index
  }
  return [...(plugin.groups ?? [])].sort((left, right) => rank(left) - rank(right))
}

export function enabledToolGroups(plugin: PluginCandidate): string[] {
  return toolGroups(plugin)
    .filter((group) => group.enabled)
    .map((group) => group.id)
}

export function artifactUnavailable(plugin: PluginCandidate) {
  return (
    plugin.artifactAvailable === false ||
    Boolean(plugin.artifactError) ||
    PLUGIN_HARNESSES.some((harness) => plugin.harnesses[harness].effective.status === "artifact-unavailable")
  )
}

export type PluginStatusTone = "normal" | "warning" | "critical" | "accent"

export type PluginStatus = Phrase & { readonly tone: PluginStatusTone; readonly attention: boolean }

function builtInStatus(plugin: PluginCandidate): PluginStatus {
  if (!isInstalled(plugin)) return { key: "marketplace.status.builtInOff", tone: "normal", attention: false }
  const groups = enabledToolGroups(plugin)
  return groups.length > 0
    ? { key: "marketplace.status.builtInOn", params: { groups: groups.join(", ") }, tone: "normal", attention: false }
    : { key: "marketplace.status.builtInNoGroups", tone: "warning", attention: false }
}

const UPDATE_AVAILABLE: PluginStatus = { key: "marketplace.status.updateAvailable", tone: "accent", attention: false }

export function pluginStatus(plugin: PluginCandidate): PluginStatus | undefined {
  if (isBuiltIn(plugin)) return builtInStatus(plugin)
  if (!isInstalled(plugin)) return plugin.updateAvailable ? UPDATE_AVAILABLE : undefined
  if (artifactUnavailable(plugin))
    return { key: "marketplace.status.artifactUnavailable", tone: "critical", attention: true }
  if (oauthServers(plugin).length > 0)
    return { key: "marketplace.status.needsAuthentication", tone: "warning", attention: true }
  if (plugin.updateAvailable) return UPDATE_AVAILABLE
  const count = installedHarnesses(plugin).length
  const key = count === 1 ? "marketplace.status.installedOne" : "marketplace.status.installedMany"
  return { key, params: { count }, tone: "normal", attention: false }
}

function decided(state: PluginActivation) {
  return (
    (state.explicit !== undefined && state.explicit !== null) ||
    (state.projectOverride !== undefined && state.projectOverride !== null) ||
    (state.userDefault !== undefined && state.userDefault !== null) ||
    state.organizationDefault !== undefined ||
    state.claxedoDefault !== undefined
  )
}

function authorityKey(winner: string): MarketplaceKey {
  switch (winner) {
    case "project":
    case "user-default":
      return "marketplace.authority.yours"
    case "organization":
      return "marketplace.authority.organization"
    case "claxedo":
      return "marketplace.authority.claxedo"
    case "machine":
      return "marketplace.authority.machine"
    default:
      return "marketplace.authority.none"
  }
}

export function activationSummary(plugin: PluginCandidate): { readonly state: Phrase; readonly authority?: Phrase } {
  const installed = isInstalled(plugin)
  const harness =
    PLUGIN_HARNESSES.find((id) => plugin.harnesses[id].effective.effective) ??
    PLUGIN_HARNESSES.find((id) => decided(plugin.harnesses[id]))
  if (!installed && !harness) return { state: { key: "marketplace.facts.notInstalled" } }
  const winner = harness ? plugin.harnesses[harness].effective.winner : "none"
  return {
    state: { key: installed ? "marketplace.facts.enabled" : "marketplace.facts.disabled" },
    authority: { key: authorityKey(winner) },
  }
}

export function defaultOutcome(input: {
  readonly plugin: PluginCandidate
  readonly harnesses: readonly PluginHarness[]
}): { readonly authority: "organization" | "claxedo"; readonly enabled: boolean } {
  const states = input.harnesses.map((harness) => input.plugin.harnesses[harness])
  return {
    authority: states.some((state) => state.organizationDefault !== undefined) ? "organization" : "claxedo",
    enabled: states.some((state) => state.organizationDefault ?? state.claxedoDefault ?? false),
  }
}

export function matchesQuery(plugin: PluginCandidate, query: string) {
  if (!query) return true
  const haystack = [
    pluginLabel(plugin),
    plugin.manifest?.description ?? "",
    ...plugin.skills.map((skill) => skill.name),
    ...plugin.mcpServers.map((server) => server.name),
    ...(plugin.groups ?? []).flatMap((group) => [group.id, ...group.tools]),
  ]
    .join(" ")
    .toLowerCase()
  return haystack.includes(query)
}

export function skillBody(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown)
  return (match ? markdown.slice(match[0].length) : markdown).replace(/^\s+/, "")
}
