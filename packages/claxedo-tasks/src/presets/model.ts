import { utf8ByteLength } from "@claxedo/helpers/string"
import {
  CONFIGURATION_SLOTS,
  TASKS_BOUNDS,
  type ConfigurationSlot,
  type HarnessReference,
  type ModelConfiguration,
  type PluginReference,
  type PresetConfigurations,
  type PresetDraft,
  type SkillReference,
} from "../contracts"
import type { HarnessDescriptor } from "../ports/capabilities"
import { collectFields, parsedInvalid, parsedOk, type Parsed } from "../validation"

export type HarnessLookup = (reference: HarnessReference) => HarnessDescriptor | undefined

export function configurationEntries(
  source: Readonly<{ configurations: PresetConfigurations }>,
): readonly (readonly [ConfigurationSlot, ModelConfiguration])[] {
  const entries: (readonly [ConfigurationSlot, ModelConfiguration])[] = []
  for (const slot of CONFIGURATION_SLOTS) {
    const configuration = source.configurations[slot]
    if (configuration) entries.push([slot, configuration])
  }
  return entries
}

/** The harness references a draft names, so a service can resolve them in one pass. */
export function draftHarnesses(draft: PresetDraft): readonly HarnessReference[] {
  return configurationEntries(draft).map(([, configuration]) => configuration.harness)
}

// A separator no catalog id may contain, so `a` + `b:c` and `a:b` + `c` cannot
// render the same key and let one duplicate hide behind another.
function pluginKey(reference: PluginReference): string {
  return `${reference.sourceId}\0${reference.pluginName}`
}

function skillKey(reference: SkillReference): string {
  return `${reference.sourceId}\0${reference.skillName}`
}

/**
 * Bounds and semantic rules for a preset draft. It never rewrites what it was
 * given: an unavailable effort or harness is a named invalid field, not a
 * substituted value, and a rejected plugin is never silently dropped.
 */
export function validatePresetDraft(draft: PresetDraft, harness: HarnessLookup): Parsed<PresetDraft> {
  const fields = collectFields()

  if (draft.name.trim().length === 0) fields.add("name", "required")
  else if (draft.name.length > TASKS_BOUNDS.presetNameMax) fields.add("name", "too_long")
  if (utf8ByteLength(draft.instructions) > TASKS_BOUNDS.instructionsMaxBytes) fields.add("instructions", "too_long")

  if (draft.execution.placement === "cloud") {
    const { plugins, skills } = draft.execution.capabilities
    if (plugins.length > TASKS_BOUNDS.pluginReferencesMax) fields.add("execution.capabilities.plugins", "too_many")
    if (skills.length > TASKS_BOUNDS.skillReferencesMax) fields.add("execution.capabilities.skills", "too_many")
    const seenPlugins = new Set<string>()
    plugins.forEach((reference, index) => {
      const key = pluginKey(reference)
      if (seenPlugins.has(key)) fields.add(`execution.capabilities.plugins[${index}]`, "duplicate")
      seenPlugins.add(key)
    })
    const seenSkills = new Set<string>()
    skills.forEach((reference, index) => {
      const key = skillKey(reference)
      if (seenSkills.has(key)) fields.add(`execution.capabilities.skills[${index}]`, "duplicate")
      seenSkills.add(key)
    })
  }

  for (const [slot, configuration] of configurationEntries(draft)) {
    const descriptor = harness(configuration.harness)
    if (!descriptor) {
      fields.add(`configurations.${slot}.harness`, "unknown_value")
      continue
    }
    if (configuration.effort !== null && !descriptor.efforts.includes(configuration.effort)) {
      fields.add(`configurations.${slot}.effort`, "unknown_value")
    }
  }

  return fields.ok ? parsedOk(draft) : parsedInvalid(fields.fields)
}
