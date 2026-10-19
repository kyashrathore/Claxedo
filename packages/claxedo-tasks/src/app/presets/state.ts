import type { Preset, PresetPlacement } from "../../contracts"
import type { TasksRefusal } from "../refusal"
import type { CapabilityCatalog } from "./catalog"
import type { DraftField, DraftProblem, PresetEditorDraft } from "./draft"

export type PresetList =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly presets: readonly Preset[] }
  | { readonly kind: "failed"; readonly message: string }

export type CatalogLoad =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly catalog: CapabilityCatalog }
  | { readonly kind: "failed" }

export type EditorTarget = { readonly presetId: string; readonly revision: number; readonly name: string }

export type PresetEditor =
  | { readonly kind: "closed" }
  | {
      readonly kind: "open"
      readonly target?: EditorTarget
      readonly draft: PresetEditorDraft
      readonly problems: Partial<Record<DraftField, DraftProblem>>
      readonly saving: boolean
      readonly attempted: boolean
      readonly refusal?: TasksRefusal
      readonly changedElsewhere: boolean
    }

export type PresetsState = {
  readonly list: PresetList
  readonly showArchived: boolean
  readonly busyPresetId?: string
  readonly placements: readonly PresetPlacement[]
  readonly catalog: CatalogLoad
  readonly editor: PresetEditor
}

export const INITIAL_PRESETS_STATE: PresetsState = {
  list: { kind: "loading" },
  showArchived: false,
  placements: ["local"],
  catalog: { kind: "idle" },
  editor: { kind: "closed" },
}

export type OpenEditor = Extract<PresetEditor, { kind: "open" }>

export function openEditor(draft: PresetEditorDraft, target?: EditorTarget): OpenEditor {
  return { kind: "open", ...(target ? { target } : {}), draft, problems: {}, saving: false, attempted: false, changedElsewhere: false }
}
