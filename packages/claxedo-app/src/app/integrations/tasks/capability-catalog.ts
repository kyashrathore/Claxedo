import { useQuery } from "@tanstack/solid-query"
import type { CapabilityCatalog, CapabilityOption } from "@/features/tasks/view-model"
import { agentPluginApi, type PluginCandidate, type PluginCatalog } from "@/features/agent-plugins/api"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"

/**
 * The installed plugins and skills a cloud preset may select from.
 *
 * The Agent Plugins catalog is the authoritative list of what this account has
 * retained; Tasks reads it and never builds a second one. Entries whose
 * artifact is unavailable are listed and refused rather than hidden, so a
 * preset cannot quietly shrink to what happens to be reachable today.
 */
export function useCapabilityCatalog(): () => CapabilityCatalog {
  const catalog = useQuery<PluginCatalog>(() => ({
    queryKey: ["tasks", "capability-catalog", getClaxedoServerUrl()],
    staleTime: 60_000,
    queryFn: () => agentPluginApi({ baseUrl: getClaxedoServerUrl(), request: authFetch }).catalog(),
  }))

  return () => {
    const candidates = catalog.data?.candidates ?? []
    return {
      plugins: candidates.flatMap(pluginOption),
      skills: candidates.flatMap(skillOptions),
      loading: catalog.isPending,
      error: catalog.error ? String(catalog.error) : undefined,
    }
  }
}

function availability(candidate: PluginCandidate) {
  if (!candidate.sourceAvailable) return "No source serves this plugin any more."
  if (candidate.artifactAvailable === false) return candidate.artifactError ?? "The retained artifact is unavailable."
  return undefined
}

function pluginOption(candidate: PluginCandidate): CapabilityOption[] {
  const sourceId = candidate.sourceId
  const name = candidate.manifest?.name
  if (!sourceId || !name) return []
  const unavailableReason = availability(candidate)
  return [
    {
      key: `${sourceId}/${name}`,
      sourceId,
      name,
      label: name,
      ...(candidate.manifest?.description ? { description: candidate.manifest.description } : {}),
      bundledSkills: candidate.skills.map((skill) => skill.name),
      available: unavailableReason === undefined,
      ...(unavailableReason ? { unavailableReason } : {}),
    },
  ]
}

function skillOptions(candidate: PluginCandidate): CapabilityOption[] {
  const sourceId = candidate.sourceId
  if (!sourceId) return []
  const unavailableReason = availability(candidate)
  return candidate.skills.map((skill) => ({
    key: `${sourceId}/${skill.name}`,
    sourceId,
    name: skill.name,
    label: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    available: unavailableReason === undefined,
    ...(unavailableReason ? { unavailableReason } : {}),
  }))
}
