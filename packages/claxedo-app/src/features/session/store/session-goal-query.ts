import type { Accessor } from "solid-js"
import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import { queryClient } from "@/platform/query/query-client"
import { authFetch } from "@/platform/api/api"
import type { AgentRuntimeGoalMutationResult } from "@/platform/runtime/agent/agent-runtime-client"
import { supportsAgentRuntimeGoalAction } from "@/platform/runtime/agent/agent-runtime-goal-client"
import { shouldAcceptSessionTransportResult } from "./session-history-activation"
import { leasedQueryRequest } from "./leased-query-request"
import {
  sessionResourceAuthorityKey,
  sessionResourceAuthorityScope,
  type SessionResourceAuthorityScope,
} from "./session-resource-authority"
import {
  sessionGoalKey,
  sessionGoalRevision,
  touchSessionGoalData,
  writeSessionGoalData,
  writeSessionGoalDataAtRevision,
  type SessionGoalData,
} from "./session-goal-cache"
import {
  deleteSessionGoalByTransport,
  fetchSessionGoalStateByTransport,
  pauseSessionGoalByTransport,
  resumeSessionGoalByTransport,
  stopSessionGoalByTransport,
  type SessionGoalTransportScope,
} from "./session-transport"

export { sessionGoalKey, setSessionGoalData, type SessionGoalData } from "./session-goal-cache"

// Goal start is not a query-cache mutation: the composer provisions and starts
// Goals through submit-goal.ts and the runtime client, which owns the
// provisioning semantics. This union covers only mutations on an existing Goal.
export type SessionGoalMutation = "pause" | "resume" | "stop" | "delete"

/**
 * The transport call each mutation makes. A record keyed by the union rather
 * than a switch, so adding a member to `SessionGoalMutation` is a type error
 * here instead of a silent fall-through.
 */
const goalMutationTransport: Record<
  SessionGoalMutation,
  (input: SessionGoalTransportScope) => Promise<AgentRuntimeGoalMutationResult>
> = {
  pause: pauseSessionGoalByTransport,
  resume: resumeSessionGoalByTransport,
  stop: stopSessionGoalByTransport,
  delete: deleteSessionGoalByTransport,
}

function transportAuthority(input: SessionGoalTransportScope) {
  return sessionResourceAuthorityKey(sessionGoalAuthorityScope(input))
}

export function sessionGoalAuthorityScope(input: SessionGoalTransportScope): SessionResourceAuthorityScope {
  return sessionResourceAuthorityScope({
    sessionID: input.sessionID,
    directory: input.directory,
    serverUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    hostKind: input.hostKind,
    sessionRef: input.sessionRef,
  })
}

function requestScope(input: SessionGoalTransportScope) {
  return ["runtime", "session-goal-request", transportAuthority(input)] as const
}

/**
 * One round-trip per activation.
 *
 * The runtime has to derive the Goal capabilities to answer either read, so
 * `/session/:id/goal/state` composes both server-side, including whether the
 * harness implements Goals at all — the client does not re-derive that rule.
 */
function readSessionGoal(input: SessionGoalTransportScope, signal?: AbortSignal): Promise<SessionGoalData> {
  return fetchSessionGoalStateByTransport({ ...input, signal })
}

export async function syncSessionGoalData(input: {
  request: SessionGoalTransportScope
  currentSessionID: Accessor<string | undefined>
  currentDirectory: Accessor<string | undefined>
  signal?: AbortSignal
}) {
  try {
    const scope = sessionGoalAuthorityScope(input.request)
    const revision = sessionGoalRevision(scope)
    const data = await leasedQueryRequest({
      scopeKey: requestScope(input.request),
      authority: input.request.request ?? authFetch,
      signal: input.signal,
      queryFn: (signal) => readSessionGoal(input.request, signal),
    })
    if (input.signal?.aborted) return false
    if (!shouldAcceptSessionTransportResult({
      expectedSessionID: input.request.sessionID,
      currentSessionID: input.currentSessionID(),
      expectedDirectory: input.request.directory,
      currentDirectory: input.currentDirectory(),
    })) return false
    return writeSessionGoalDataAtRevision(scope, revision, () => data)
  } catch (error) {
    if (input.signal?.aborted) return false
    throw error
  }
}

export class SessionGoalMutationError extends Error {
  readonly status: Exclude<AgentRuntimeGoalMutationResult, { ok: true }>["status"]

  constructor(result: Exclude<AgentRuntimeGoalMutationResult, { ok: true }>) {
    super(result.message)
    this.name = "SessionGoalMutationError"
    this.status = result.status
  }
}

export async function mutateSessionGoalData(input: {
  request: SessionGoalTransportScope
  mutation: SessionGoalMutation
}) {
  const scope = sessionGoalAuthorityScope(input.request)
  const current = queryClient.getQueryData<SessionGoalData>(sessionGoalKey(scope))
  if (!current) throw new Error("Goal state must be synchronized before it can be changed")
  if (!current.capabilities.available || !current.capabilities.implemented) {
    throw new Error(current.capabilities.unavailableReason ?? "Goals are unavailable")
  }
  if (input.mutation !== "stop" && !supportsAgentRuntimeGoalAction(current.capabilities, input.mutation)) {
    throw new Error(`Goal action '${input.mutation}' is unavailable`)
  }
  const revision = sessionGoalRevision(scope)
  const result = await goalMutationTransport[input.mutation](input.request)
  if (!result.ok) throw new SessionGoalMutationError(result)
  writeSessionGoalDataAtRevision(scope, revision, (latest) => latest
    ? { ...latest, goal: result.goal }
    : latest)
  return result.goal
}

type GoalRuntimeEvent = Extract<AgentRuntimeEvent, { type: "goal-updated" | "goal-cleared" }>

export function applySessionGoalRuntimeEvent(input: {
  scope: SessionResourceAuthorityScope
  sessionId: string
  payload: GoalRuntimeEvent
}) {
  if (input.sessionId !== input.scope.sessionID || input.payload.sessionId !== input.scope.sessionID) return false
  let applied = false
  let touched = false
  writeSessionGoalData(input.scope, (current) => {
    if (!current) return current
    if (input.payload.type === "goal-cleared") {
      if (current.goal === null) {
        touched = true
        return current
      }
      applied = true
      return { ...current, goal: null }
    }
    if (current.goal && current.goal.updatedAt > input.payload.goal.updatedAt) return current
    applied = true
    return { ...current, goal: input.payload.goal }
  })
  if (touched) touchSessionGoalData(input.scope)
  return applied
}

export function invalidateSessionGoalData(scope: SessionResourceAuthorityScope) {
  return queryClient.invalidateQueries({ queryKey: sessionGoalKey(scope), exact: true })
}

/**
 * Call `onInvalidate` whenever this Goal authority's cache entry is invalidated.
 *
 * The pane's Goal query is a cache mirror (`skipToken` + `enabled: false`) fed by
 * `syncSessionGoalData`, so `invalidateQueries` can never refetch it on its own:
 * the invalidation only marks the entry stale. The mounted controller turns that
 * mark into a real re-read; an unmounted one leaves the mark for the next
 * activation's `sync()` to honour.
 */
export function observeSessionGoalInvalidation(
  scope: SessionResourceAuthorityScope,
  onInvalidate: () => void,
) {
  const queryHash = queryClient.defaultQueryOptions({ queryKey: sessionGoalKey(scope) }).queryHash
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "invalidate") return
    if (event.query.queryHash !== queryHash) return
    onInvalidate()
  })
}
