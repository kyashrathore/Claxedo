import { useQuery } from "@tanstack/solid-query"
import { useServer, type PluginCandidate } from "@/server"
import type { TasksKey } from "../i18n"

export type CapabilityOption = {
  readonly key: string
  readonly sourceId: string
  readonly name: string
  readonly description?: string
  readonly bundledSkills?: readonly string[]
  readonly unavailable?: { readonly key: TasksKey } | { readonly text: string }
}

export type CapabilityCatalog = {
  readonly plugins: readonly CapabilityOption[]
  readonly skills: readonly CapabilityOption[]
  readonly loading: boolean
  readonly error?: string
}

function unavailability(candidate: PluginCandidate): CapabilityOption["unavailable"] {
  if (!candidate.sourceAvailable) return { key: "tasks.preset.noSource" }
  if (candidate.artifactAvailable !== false) return undefined
  return candidate.artifactError ? { text: candidate.artifactError } : { key: "tasks.preset.artifactUnavailable" }
}

function pluginOption(candidate: PluginCandidate): CapabilityOption[] {
  const sourceId = candidate.sourceId
  const name = candidate.manifest?.name
  if (!sourceId || !name) return []
  const description = candidate.manifest?.description
  const unavailable = unavailability(candidate)
  return [
    {
      key: `${sourceId}/${name}`,
      sourceId,
      name,
      ...(description ? { description } : {}),
      bundledSkills: candidate.skills.map((skill) => skill.name),
      ...(unavailable ? { unavailable } : {}),
    },
  ]
}

function skillOptions(candidate: PluginCandidate): CapabilityOption[] {
  const sourceId = candidate.sourceId
  if (!sourceId) return []
  const unavailable = unavailability(candidate)
  return candidate.skills.map((skill) => ({
    key: `${sourceId}/${skill.name}`,
    sourceId,
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    ...(unavailable ? { unavailable } : {}),
  }))
}

export function useCapabilityCatalog(): () => CapabilityCatalog {
  const server = useServer()
  const catalog = useQuery(() => ({ ...server.queries.marketplace.catalog(), staleTime: 60_000 }))
  return () => {
    const candidates = catalog.data?.candidates ?? []
    return {
      plugins: candidates.flatMap(pluginOption),
      skills: candidates.flatMap(skillOptions),
      loading: catalog.isPending,
      ...(catalog.error ? { error: catalog.error.message } : {}),
    }
  }
}
