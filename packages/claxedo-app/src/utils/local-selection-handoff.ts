import { queryClient } from "@claxedo/shared/query/query-client"
import { shellDataKeys } from "@claxedo/shell/data/keys"
import type { ModelKey } from "@claxedo/session-client/composer/model-strategy"

export type LocalSelectionState = {
  agent?: string
  model?: ModelKey
  variant?: string | null
}

const localSelectionHandoffPart = "local-selection-handoff"

export function localSelectionHandoffQueryKey(sessionID: string) {
  return shellDataKeys.sessionId(sessionID, localSelectionHandoffPart)
}

export function cloneLocalSelectionState(value: LocalSelectionState | undefined) {
  if (!value) return
  return {
    ...value,
    model: value.model ? { ...value.model } : undefined,
  } satisfies LocalSelectionState
}

export function getLocalSelectionHandoff(sessionID: string) {
  return cloneLocalSelectionState(queryClient.getQueryData<LocalSelectionState>(localSelectionHandoffQueryKey(sessionID)))
}

export function setLocalSelectionHandoff(sessionID: string, state: LocalSelectionState) {
  queryClient.setQueryData(localSelectionHandoffQueryKey(sessionID), cloneLocalSelectionState(state))
}

export function clearLocalSelectionHandoff(sessionID: string) {
  queryClient.removeQueries({ queryKey: localSelectionHandoffQueryKey(sessionID), exact: true })
}
