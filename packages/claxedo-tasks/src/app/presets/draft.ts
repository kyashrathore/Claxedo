import type { SurfaceAgentConfiguration } from "@claxedo/plugin-api/surface"
import { CONFIGURATION_SLOTS, TASKS_BOUNDS, type ConfigurationSlot, type ModelConfiguration, type Preset, type PresetDraft, type PresetPlacement } from "../../contracts"
import { cloudPresetHarnessRefusal } from "../../presets/model"
import type { TasksKey } from "../dictionary"

export type AgentConfiguration = SurfaceAgentConfiguration

export type CapabilitySelection = { readonly sourceId: string; readonly name: string }

export type PresetEditorDraft = {
  readonly name: string
  readonly instructions: string
  readonly placement: PresetPlacement
  readonly plugins: readonly CapabilitySelection[]
  readonly skills: readonly CapabilitySelection[]
  readonly configurations: Readonly<Record<ConfigurationSlot, AgentConfiguration | null>>
  readonly agentStartable: boolean
}

export type DraftProblem =
  | { readonly kind: "words"; readonly key: TasksKey; readonly params?: Readonly<Record<string, string | number>> }
  | { readonly kind: "kit"; readonly text: string }

export type DraftField = "name" | ConfigurationSlot

export const EMPTY_CONFIGURATION: AgentConfiguration = { harness: null, model: null, effort: null }

export const OPTIONAL_SLOTS = CONFIGURATION_SLOTS.filter((slot): slot is Exclude<ConfigurationSlot, "primary"> => slot !== "primary")

export function emptyPresetDraft(): PresetEditorDraft {
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

function editableConfiguration(configuration: ModelConfiguration | undefined): AgentConfiguration | null {
  return configuration ? { harness: configuration.harness, model: configuration.model, effort: configuration.effort } : null
}

export function presetDraftOf(preset: Preset): PresetEditorDraft {
  const selected = preset.execution.placement === "cloud" ? preset.execution.capabilities : undefined
  return {
    name: preset.name,
    instructions: preset.instructions,
    placement: preset.execution.placement,
    plugins: (selected?.plugins ?? []).map((entry) => ({ sourceId: entry.sourceId, name: entry.pluginName })),
    skills: (selected?.skills ?? []).map((entry) => ({ sourceId: entry.sourceId, name: entry.skillName })),
    configurations: {
      primary: editableConfiguration(preset.configurations.primary) ?? EMPTY_CONFIGURATION,
      planning: editableConfiguration(preset.configurations.planning),
      implementation: editableConfiguration(preset.configurations.implementation),
      review: editableConfiguration(preset.configurations.review),
    },
    agentStartable: preset.agentStartable,
  }
}

function nameProblem(name: string): DraftProblem | undefined {
  if (name.trim().length === 0) return { kind: "words", key: "claxedo-tasks.preset.nameRequired" }
  if (name.length > TASKS_BOUNDS.presetNameMax) return { kind: "words", key: "claxedo-tasks.preset.nameTooLong", params: { max: TASKS_BOUNDS.presetNameMax } }
  return undefined
}

export function cloudHarnessProblem(draft: PresetEditorDraft, slot: ConfigurationSlot): DraftProblem | undefined {
  const harness = draft.configurations[slot]?.harness
  if (draft.placement !== "cloud" || !harness) return undefined
  const refusal = cloudPresetHarnessRefusal(harness)
  return refusal ? { kind: "kit", text: refusal } : undefined
}

function slotProblem(draft: PresetEditorDraft, slot: ConfigurationSlot): DraftProblem | undefined {
  const entry = draft.configurations[slot]
  if (!entry) return undefined
  const cloud = cloudHarnessProblem(draft, slot)
  if (cloud) return cloud
  if (!entry.harness) return { kind: "words", key: "claxedo-tasks.preset.chooseHarness" }
  if (!entry.model) return { kind: "words", key: "claxedo-tasks.preset.chooseModel" }
  return undefined
}

export function draftProblems(draft: PresetEditorDraft): Partial<Record<DraftField, DraftProblem>> {
  const problems: Partial<Record<DraftField, DraftProblem>> = {}
  const name = nameProblem(draft.name)
  if (name) problems.name = name
  for (const slot of CONFIGURATION_SLOTS) {
    const problem = slotProblem(draft, slot)
    if (problem) problems[slot] = problem
  }
  return problems
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

function modelConfigurations(draft: PresetEditorDraft): Partial<Record<ConfigurationSlot, ModelConfiguration>> {
  const configurations: Partial<Record<ConfigurationSlot, ModelConfiguration>> = {}
  for (const slot of CONFIGURATION_SLOTS) {
    const entry = draft.configurations[slot]
    if (entry?.harness && entry.model) configurations[slot] = { harness: entry.harness, model: entry.model, effort: entry.effort }
  }
  return configurations
}

export function presetDraftInput(draft: PresetEditorDraft): PresetDraft | undefined {
  const configurations = modelConfigurations(draft)
  const primary = configurations.primary
  if (!primary || Object.keys(draftProblems(draft)).length > 0) return undefined
  return {
    name: draft.name.trim(),
    instructions: draft.instructions,
    execution: executionOf(draft),
    configurations: { ...configurations, primary },
    agentStartable: draft.agentStartable,
  }
}
