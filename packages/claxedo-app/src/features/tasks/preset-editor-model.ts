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
import type { JSX } from "solid-js"
import type { FieldErrors } from "./view-model"

/**
 * One plugin or skill the draft has selected.
 *
 * The contract spells the name differently per kind (`pluginName`, `skillName`);
 * the draft holds one shape so the picker and its toggle are written once, and
 * `parsePresetEditorDraft` puts the contract's spelling back on.
 */
export type CapabilitySelection = { sourceId: string; name: string }

/**
 * A configuration while it is being edited. Model is nullable because a
 * harness change clears it: the previous harness's model is not a legal value
 * for the new one, and carrying it forward would be the silent substitution
 * the design forbids.
 */
export type ConfigurationDraft = {
  harness: HarnessReference | null
  model: ModelReference | null
  effort: string | null
}

export type PresetEditorDraft = {
  name: string
  instructions: string
  placement: PresetPlacement
  /** Retained while Local is selected so switching back to Cloud does not lose the selection. */
  plugins: readonly CapabilitySelection[]
  skills: readonly CapabilitySelection[]
  configurations: Readonly<Record<ConfigurationSlot, ConfigurationDraft | null>>
  agentStartable: boolean
}

/**
 * The harness/model/effort control. It lives in the host because the
 * authoritative provider and harness catalogs do, and because the same
 * selectors serve the composer. It reads and writes the editing draft, so a
 * half-chosen configuration is representable rather than rounded off.
 */
export type ConfigurationEditorProps = {
  /** Identifies THIS editor, so its selector state cannot collide with a composer pane's. */
  editorKey: string
  slot: ConfigurationSlot
  configuration: ConfigurationDraft
  onChange: (configuration: ConfigurationDraft) => void
  disabled: boolean
  placement: PresetPlacement
}

export type ConfigurationEditor = (props: ConfigurationEditorProps) => JSX.Element

export const EMPTY_CONFIGURATION: ConfigurationDraft = { harness: null, model: null, effort: null }

export function emptyPresetEditorDraft(): PresetEditorDraft {
  return {
    name: "",
    instructions: "",
    placement: "local",
    plugins: [],
    skills: [],
    configurations: {
      primary: EMPTY_CONFIGURATION,
      planning: null,
      implementation: null,
      review: null,
    },
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

/**
 * Fold one report from the configuration control into the slot's draft.
 *
 * A control that switches harness while still naming the previous harness's
 * model is carrying it over, and that model is not a validated choice under the
 * new harness. Clearing it is what makes the next submit name the field instead
 * of sending a substitute. A control that genuinely resolved a model for the
 * new harness reports a different one and is taken as it stands; when both
 * harnesses happen to offer the same model the user re-picks it, which is the
 * safe direction of the two.
 */
export function rebaseConfiguration(previous: ConfigurationDraft | null, next: ConfigurationDraft): ConfigurationDraft {
  if (!previous?.harness || !next.harness || sameHarness(previous.harness, next.harness)) return next
  const carried =
    !!previous.model &&
    !!next.model &&
    previous.model.providerID === next.model.providerID &&
    previous.model.modelID === next.model.modelID
  return carried ? { harness: next.harness, model: null, effort: null } : next
}

export function configurationOf(draft: ConfigurationDraft | null): ModelConfiguration | undefined {
  if (!draft?.harness || !draft.model) return undefined
  return { harness: draft.harness, model: draft.model, effort: draft.effort }
}

export type PresetEditorParse =
  | { ok: true; draft: PresetDraft }
  | { ok: false; fields: FieldErrors }

/**
 * Turn the editor's draft into the contract shape, or name every field that
 * stops it. Nothing is defaulted here: an unfinished configuration is an
 * error, never an omitted slot.
 */
export function parsePresetEditorDraft(draft: PresetEditorDraft): PresetEditorParse {
  const fields: Record<string, string> = {}
  if (draft.name.trim().length === 0) fields.name = "Name is required."
  else if (draft.name.length > TASKS_BOUNDS.presetNameMax) {
    fields.name = `Name is longer than ${TASKS_BOUNDS.presetNameMax} characters.`
  }

  const configurations: Partial<Record<ConfigurationSlot, ModelConfiguration>> = {}
  for (const slot of CONFIGURATION_SLOTS) {
    const entry = draft.configurations[slot]
    if (!entry) continue
    if (!entry.harness) {
      fields[`configurations.${slot}.harness`] = "Choose a harness."
      continue
    }
    if (!entry.model) {
      fields[`configurations.${slot}.model`] = "Choose a model for this harness."
      continue
    }
    configurations[slot] = { harness: entry.harness, model: entry.model, effort: entry.effort }
  }
  const primary = configurations.primary
  if (!primary) fields["configurations.primary"] ??= "The primary configuration is required."

  if (Object.keys(fields).length > 0 || !primary) return { ok: false, fields }

  return {
    ok: true,
    draft: {
      name: draft.name.trim(),
      instructions: draft.instructions,
      execution:
        draft.placement === "cloud"
          ? {
              placement: "cloud",
              capabilities: {
                mode: "selected",
                plugins: draft.plugins.map((entry) => ({ sourceId: entry.sourceId, pluginName: entry.name })),
                skills: draft.skills.map((entry) => ({ sourceId: entry.sourceId, skillName: entry.name })),
              },
            }
          : { placement: "local", capabilities: { mode: "inherit-local" } },
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
