import { asRecord, nonEmptyString } from "@claxedo/helpers/guards"
import type { CapabilitySelection } from "./draft"

export const PLUGIN_CATALOG_PATH = "/api/claxedo/plugins"

/**
 * `unretained`: the source offers it but nobody turned it on for this person,
 * so no pin entitles a cloud root to it and every start of a preset naming it
 * is refused.
 */
export type CapabilityAvailability = "ready" | "unretained" | "unavailable"

export type CapabilityEntry = {
  readonly selection: CapabilitySelection
  readonly description?: string
  readonly bundledSkills: readonly string[]
  readonly availability: CapabilityAvailability
}

export type CapabilityCatalog = { readonly plugins: readonly CapabilityEntry[]; readonly skills: readonly CapabilityEntry[] }

export function capabilityKey(selection: CapabilitySelection): string {
  return `${selection.sourceId}/${selection.name}`
}

function skillsOf(candidate: Record<string, unknown>): { readonly name: string; readonly description?: string }[] {
  const skills = Array.isArray(candidate.skills) ? candidate.skills : []
  return skills.flatMap((entry) => {
    const skill = asRecord(entry)
    const name = nonEmptyString(skill?.name)
    const description = nonEmptyString(skill?.description)
    return name ? [{ name, ...(description ? { description } : {}) }] : []
  })
}

function candidateEntries(value: unknown): CapabilityCatalog {
  const candidate = asRecord(value)
  const sourceId = nonEmptyString(candidate?.sourceId)
  if (!candidate || !sourceId) return { plugins: [], skills: [] }
  const availability: CapabilityAvailability = candidate.sourceAvailable !== true || candidate.artifactAvailable === false
    ? "unavailable"
    : nonEmptyString(candidate.retainedDigest) ? "ready" : "unretained"
  const skills = skillsOf(candidate)
  const manifest = asRecord(candidate.manifest)
  const name = nonEmptyString(manifest?.name)
  const description = nonEmptyString(manifest?.description)
  const plugin: CapabilityEntry[] = name
    ? [{ selection: { sourceId, name }, ...(description ? { description } : {}), bundledSkills: skills.map((skill) => skill.name), availability }]
    : []
  return {
    plugins: plugin,
    skills: skills.map((skill) => ({ selection: { sourceId, name: skill.name }, ...(skill.description ? { description: skill.description } : {}), bundledSkills: [], availability })),
  }
}

export function capabilityCatalogOf(payload: unknown): CapabilityCatalog {
  const candidates = asRecord(payload)?.candidates
  const entries = (Array.isArray(candidates) ? candidates : []).map(candidateEntries)
  return { plugins: entries.flatMap((entry) => entry.plugins), skills: entries.flatMap((entry) => entry.skills) }
}
