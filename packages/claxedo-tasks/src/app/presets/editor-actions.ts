import type { Json } from "../surface/json"
import { editorDraftOf } from "./client-draft"
import { CONFIGURATION_SLOTS } from "../../contracts"
import { cloudHarnessProblem, draftProblems, type DraftField, type DraftProblem, type PresetEditorDraft } from "./draft"
import type { OpenEditor } from "./state"

function cloudProblems(draft: PresetEditorDraft): Partial<Record<DraftField, DraftProblem>> {
  const problems: Partial<Record<DraftField, DraftProblem>> = {}
  for (const slot of CONFIGURATION_SLOTS) {
    const problem = cloudHarnessProblem(draft, slot)
    if (problem) problems[slot] = problem
  }
  return problems
}

export function editedEditor(editor: OpenEditor, value: Json | undefined): OpenEditor {
  const draft = editorDraftOf(value, editor.draft)
  return { ...editor, draft, problems: editor.attempted ? draftProblems(draft) : cloudProblems(draft) }
}

export function hasProblems(editor: OpenEditor): boolean {
  return Object.keys(editor.problems).length > 0
}
