import { queryClient } from "../../shared/query/query-client"
import { shellDataKeys } from "@/shell/data/keys"
import type { ModelKey } from "../../session/composer/model-strategy"

export type LocalSelectionState = {
  agent?: string
  model?: ModelKey
  variant?: string | null
}

const localSelectionHandoffPart = "local-selection-handoff"

export function localSelectionHandoffQueryKey(sessionID: string) {
  return shellDataKeys.sessionId(sessionID, localSelectionHandoffPart)
}

export function localDraftSelectionHandoffID(workspaceId: string) {
  return `__claxedo_draft__:${workspaceId}`
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

export function resetLocalSelectionHandoffForTest() {
  queryClient.removeQueries({
    queryKey: ["shell", "session"],
    predicate: (query) => query.queryKey[3] === localSelectionHandoffPart,
  })
}
