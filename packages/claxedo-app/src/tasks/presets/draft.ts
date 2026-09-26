import {
  CONFIGURATION_SLOTS,
  TASKS_BOUNDS,
  type ConfigurationSlot,
  type HarnessReference,
  type ModelConfiguration,
  type ModelReference,
  type Preset,
  type PresetDraft,
  type PresetPlacement,
} from "@claxedo/tasks"
import type { TasksKey } from "../i18n"

export type CapabilitySelection = { readonly sourceId: string; readonly name: string }

export type ConfigurationDraft = {
  readonly harness: HarnessReference | null
  readonly model: ModelReference | null
  readonly effort: string | null
}

export type PresetEditorDraft = {
  readonly name: string
  readonly instructions: string
  readonly placement: PresetPlacement
  readonly plugins: readonly CapabilitySelection[]
  readonly skills: readonly CapabilitySelection[]
  readonly configurations: Readonly<Record<ConfigurationSlot, ConfigurationDraft | null>>
  readonly agentStartable: boolean
}

export type FieldProblem = { readonly key: TasksKey; readonly params?: Readonly<Record<string, string | number>> }

export const EMPTY_CONFIGURATION: ConfigurationDraft = { harness: null, model: null, effort: null }

export function emptyPresetEditorDraft(): PresetEditorDraft {
  return {
    name: "",
    instructions: "",
    placement: "local",
    plugins: [],
    skills: [],
    configurations: { primary: EMPTY_CONFIGURATION, planning: null, implementation: null, review: null },
    agentStartable: false,
  }
}

export function presetEditorDraftOf(preset: Preset): PresetEditorDraft {
  const configurations: Record<ConfigurationSlot, ConfigurationDraft | null> = {
    primary: null,
    planning: null,
    implementation: null,
    review: null,
  }
  for (const slot of CONFIGURATION_SLOTS) {
    const configuration = preset.configurations[slot]
    configurations[slot] = configuration
      ? { harness: configuration.harness, model: configuration.model, effort: configuration.effort }
      : null
  }
  configurations.primary ??= EMPTY_CONFIGURATION
  const selected = preset.execution.placement === "cloud" ? preset.execution.capabilities : undefined
  return {
    name: preset.name,
    instructions: preset.instructions,
    placement: preset.execution.placement,
    plugins: (selected?.plugins ?? []).map((entry) => ({ sourceId: entry.sourceId, name: entry.pluginName })),
    skills: (selected?.skills ?? []).map((entry) => ({ sourceId: entry.sourceId, name: entry.skillName })),
    configurations,
    agentStartable: preset.agentStartable,
  }
}

function sameHarness(left: HarnessReference, right: HarnessReference) {
  return left.id === right.id && left.access === right.access
}

export function rebaseConfiguration(previous: ConfigurationDraft | null, next: ConfigurationDraft): ConfigurationDraft {
  if (!previous?.harness || !next.harness || sameHarness(previous.harness, next.harness)) return next
  const carried =
    !!previous.model &&
    !!next.model &&
    previous.model.providerID === next.model.providerID &&
    previous.model.modelID === next.model.modelID
  return carried ? { harness: next.harness, model: null, effort: null } : next
}

export type PresetEditorParse =
  | { readonly ok: true; readonly draft: PresetDraft }
  | { readonly ok: false; readonly fields: Readonly<Record<string, FieldProblem>> }

function nameProblem(name: string): FieldProblem | undefined {
  if (name.trim().length === 0) return { key: "tasks.preset.nameRequired" }
  if (name.length > TASKS_BOUNDS.presetNameMax)
    return { key: "tasks.preset.nameTooLong", params: { max: TASKS_BOUNDS.presetNameMax } }
  return undefined
}

function parseConfigurations(draft: PresetEditorDraft, fields: Record<string, FieldProblem>) {
  const configurations: Partial<Record<ConfigurationSlot, ModelConfiguration>> = {}
  for (const slot of CONFIGURATION_SLOTS) {
    const entry = draft.configurations[slot]
    if (!entry) continue
    if (!entry.harness) fields[`configurations.${slot}.harness`] = { key: "tasks.preset.chooseHarness" }
    else if (!entry.model) fields[`configurations.${slot}.model`] = { key: "tasks.preset.chooseModel" }
    else configurations[slot] = { harness: entry.harness, model: entry.model, effort: entry.effort }
  }
  return configurations
}

function executionOf(draft: PresetEditorDraft): PresetDraft["execution"] {
  if (draft.placement !== "cloud") return { placement: "local", capabilities: { mode: "inherit-local" } }
  return {
    placement: "cloud",
    capabilities: {
      mode: "selected",
      plugins: draft.plugins.map((entry) => ({ sourceId: entry.sourceId, pluginName: entry.name })),
      skills: draft.skills.map((entry) => ({ sourceId: entry.sourceId, skillName: entry.name })),
    },
  }
}

export function parsePresetEditorDraft(draft: PresetEditorDraft): PresetEditorParse {
  const fields: Record<string, FieldProblem> = {}
  const name = nameProblem(draft.name)
  if (name) fields.name = name
  const configurations = parseConfigurations(draft, fields)
  const primary = configurations.primary
  if (!primary) fields["configurations.primary"] ??= { key: "tasks.preset.primaryRequired" }
  if (Object.keys(fields).length > 0 || !primary) return { ok: false, fields }
  return {
    ok: true,
    draft: {
      name: draft.name.trim(),
      instructions: draft.instructions,
      execution: executionOf(draft),
      configurations: { ...configurations, primary },
      agentStartable: draft.agentStartable,
    },
  }
}

export function isCapabilitySelected(
  selected: readonly CapabilitySelection[],
  capability: CapabilitySelection,
): boolean {
  return selected.some((entry) => entry.sourceId === capability.sourceId && entry.name === capability.name)
}

export function toggleCapability(
  selected: readonly CapabilitySelection[],
  capability: CapabilitySelection,
): readonly CapabilitySelection[] {
  return isCapabilitySelected(selected, capability)
    ? selected.filter((entry) => !(entry.sourceId === capability.sourceId && entry.name === capability.name))
    : [...selected, capability]
}
