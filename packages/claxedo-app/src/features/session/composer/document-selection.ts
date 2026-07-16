export type DocumentSelectionState = {
  generation: number
  scope: string
  sessionId?: string
  draftId?: string
  prompt: string
}

export function documentSelectionIsCurrent(started: DocumentSelectionState, current: DocumentSelectionState) {
  return started.generation === current.generation &&
    started.scope === current.scope &&
    started.sessionId === current.sessionId &&
    started.draftId === current.draftId &&
    started.prompt === current.prompt
}

export function runForCurrentDocumentSelection(
  started: DocumentSelectionState,
  current: () => DocumentSelectionState,
  run: () => void,
) {
  if (!documentSelectionIsCurrent(started, current())) return false
  run()
  return true
}
