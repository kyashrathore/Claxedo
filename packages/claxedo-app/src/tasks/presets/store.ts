import { createStore } from "solid-js/store"
import type { Preset } from "@claxedo/tasks"
import type { TasksRefusal } from "../data/refusal"
import type { PresetEditorDraft } from "./draft"

type PresetsState = {
  selectedPresetId: string | undefined
  draft: PresetEditorDraft | undefined
  draftId: string | undefined
  revision: number | undefined
  refusal: TasksRefusal | undefined
}

export type PresetsStore = ReturnType<typeof createPresetsStore>

export function createPresetsStore() {
  const [state, setState] = createStore<PresetsState>({
    selectedPresetId: undefined,
    draft: undefined,
    draftId: undefined,
    revision: undefined,
    refusal: undefined,
  })
  return {
    state,
    open: (draft: PresetEditorDraft, preset?: Preset) =>
      setState({
        selectedPresetId: preset?.id,
        draft,
        draftId: preset?.id,
        revision: preset?.revision,
        refusal: undefined,
      }),
    setDraft: (draft: PresetEditorDraft) => setState("draft", draft),
    close: () => setState({ draft: undefined, draftId: undefined, revision: undefined, refusal: undefined }),
    refuse: (refusal: TasksRefusal) =>
      setState({ refusal, ...(refusal.stale?.preset ? { revision: refusal.stale.preset.revision } : {}) }),
    select: (presetId: string | undefined) => setState("selectedPresetId", presetId),
  }
}
