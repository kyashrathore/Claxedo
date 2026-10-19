import { asRecord } from "@claxedo/helpers/guards"
import { CONFIGURATION_SLOTS, isConfigurationSlot, type ConfigurationSlot, type PresetPlacement } from "../../contracts"
import type { Json, JsonObject } from "../surface/json"
import { capabilityKey } from "./catalog"
import { EMPTY_CONFIGURATION, OPTIONAL_SLOTS, type AgentConfiguration, type CapabilitySelection, type PresetEditorDraft } from "./draft"

export function clientDraftOf(draft: PresetEditorDraft): JsonObject {
  const configurations: JsonObject = {}
  for (const slot of CONFIGURATION_SLOTS) configurations[slot] = draft.configurations[slot] ?? null
  return {
    name: draft.name,
    instructions: draft.instructions,
    placement: [draft.placement],
    agentStartable: draft.agentStartable,
    slots: OPTIONAL_SLOTS.filter((slot) => draft.configurations[slot] !== null),
    configurations,
    plugins: draft.plugins.map(capabilityKey),
    skills: draft.skills.map(capabilityKey),
  }
}

function stringOf(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback
}

function readPlacement(value: unknown, fallback: PresetPlacement): PresetPlacement {
  const first: unknown = Array.isArray(value) ? value[0] : undefined
  return first === "local" || first === "cloud" ? first : fallback
}

function readHarness(value: unknown): AgentConfiguration["harness"] {
  const harness = asRecord(value)
  if (typeof harness?.id !== "string" || (harness.access !== "native" && harness.access !== "connection")) return null
  return { id: harness.id, access: harness.access }
}

function readModel(value: unknown): AgentConfiguration["model"] {
  const model = asRecord(value)
  return typeof model?.providerID === "string" && typeof model.modelID === "string" ? { providerID: model.providerID, modelID: model.modelID } : null
}

function readConfiguration(value: unknown): AgentConfiguration {
  const configuration = asRecord(value)
  const effort = configuration?.effort
  return { harness: readHarness(configuration?.harness), model: readModel(configuration?.model), effort: typeof effort === "string" ? effort : null }
}

function slotsOf(value: unknown): ReadonlySet<ConfigurationSlot> {
  return new Set((Array.isArray(value) ? value : []).filter(isConfigurationSlot))
}

function selectionsOf(value: unknown): CapabilitySelection[] {
  return (Array.isArray(value) ? value : []).flatMap((key) => {
    const at = typeof key === "string" ? key.lastIndexOf("/") : -1
    return typeof key === "string" && at > 0 ? [{ sourceId: key.slice(0, at), name: key.slice(at + 1) }] : []
  })
}

export function editorDraftOf(value: Json | undefined, previous: PresetEditorDraft): PresetEditorDraft {
  const draft = asRecord(value)
  if (!draft) return previous
  const slots = slotsOf(draft.slots)
  const configurations = asRecord(draft.configurations)
  const configured = (slot: ConfigurationSlot) => (slot === "primary" || slots.has(slot) ? readConfiguration(configurations?.[slot] ?? EMPTY_CONFIGURATION) : null)
  return {
    name: stringOf(draft.name, previous.name),
    instructions: stringOf(draft.instructions, previous.instructions),
    placement: readPlacement(draft.placement, previous.placement),
    agentStartable: typeof draft.agentStartable === "boolean" ? draft.agentStartable : previous.agentStartable,
    plugins: selectionsOf(draft.plugins),
    skills: selectionsOf(draft.skills),
    configurations: { primary: configured("primary") ?? EMPTY_CONFIGURATION, planning: configured("planning"), implementation: configured("implementation"), review: configured("review") },
  }
}
