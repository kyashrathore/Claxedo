import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import { queryClient } from "@/platform/query/query-client"
import type { AgentRuntimeGoalCapabilities } from "@/platform/runtime/agent/agent-runtime-client"
import {
  sessionResourceAuthorityKey,
  type SessionResourceAuthorityScope,
} from "./session-resource-authority"

export type SessionGoalData = {
  capabilities: AgentRuntimeGoalCapabilities
  goal: RuntimeGoalSnapshot | null
}

export function sessionGoalKey(scope: SessionResourceAuthorityScope) {
  return ["session-goal-v1", sessionResourceAuthorityKey(scope)] as const
}

function sessionGoalRevisionKey(scope: SessionResourceAuthorityScope) {
  return ["session-goal-revision-v1", sessionResourceAuthorityKey(scope)] as const
}

export function sessionGoalRevision(scope: SessionResourceAuthorityScope) {
  return queryClient.getQueryData<number>(sessionGoalRevisionKey(scope)) ?? 0
}

export function touchSessionGoalData(scope: SessionResourceAuthorityScope) {
  const queryKey = sessionGoalRevisionKey(scope)
  const options = queryClient.defaultQueryOptions({ queryKey })
  const current = queryClient.getQueryCache().get<number>(options.queryHash)?.state.data
  queryClient.getQueryCache().build(queryClient, options).setData((current ?? 0) + 1, { manual: true })
}

export function setSessionGoalData(scope: SessionResourceAuthorityScope, data: SessionGoalData) {
  writeSessionGoalData(scope, () => data)
}

export function writeSessionGoalData(
  scope: SessionResourceAuthorityScope,
  update: (current: SessionGoalData | undefined) => SessionGoalData | undefined,
) {
  const queryKey = sessionGoalKey(scope)
  const options = queryClient.defaultQueryOptions({ queryKey })
  const current = queryClient.getQueryCache().get<SessionGoalData>(options.queryHash)?.state.data
  const next = update(current)
  if (next === undefined || next === current) return
  queryClient.getQueryCache().build(queryClient, options).setData(next, { manual: true })
  touchSessionGoalData(scope)
}

export function writeSessionGoalDataAtRevision(
  scope: SessionResourceAuthorityScope,
  revision: number,
  update: (current: SessionGoalData | undefined) => SessionGoalData | undefined,
) {
  if (sessionGoalRevision(scope) !== revision) return false
  writeSessionGoalData(scope, update)
  return true
}
