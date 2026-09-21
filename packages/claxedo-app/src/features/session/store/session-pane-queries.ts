import type { AgentSessionStartBinding } from "@claxedo/agent-runtime-contract"
import { createAgentRuntimeClient } from "@/platform/runtime/agent/agent-runtime-client"
import { skipToken, useQuery } from "@tanstack/solid-query"
import type { Accessor } from "solid-js"
import { useWorkspaceQuery } from "@/features/session/app-ports"
import { shellDataKeys } from "@/platform/sync/keys"
import {
  directorySessionCacheQueryOptions,
  type DirectorySessionCacheValue,
  type SessionRequestsQueryData,
  type SessionStatus,
  type SnapshotFileDiff,
  type Todo,
} from "../data/sync/queries"
import type { SessionTransportCapabilities } from "./session-transport"
import type { SessionRef } from "@/platform/identity/session-ref"
import { parkedPaneQueryOptions, type PaneQueryOptions } from "./pane-query-observer"
import { sessionGoalKey, type SessionGoalData } from "./session-goal-query"
import { queryKeys } from "@/platform/query/keys"
import type { ClaxedoSession } from "../data/session-types"
import {
  sessionResourceAuthorityKey,
  sessionResourceAuthorityScope,
  type SessionResourceAuthorityScope,
} from "./session-resource-authority"
import type { RelayHostKind } from "@/platform/runtime/placement-wire"

export type SessionCapabilitiesScope = SessionResourceAuthorityScope

export function sessionCapabilitiesKey(scope: SessionCapabilitiesScope) {
  return shellDataKeys.sessionId(
    scope.sessionID,
    "transport-capabilities",
    sessionResourceAuthorityKey(scope),
  )
}

export function createSessionPaneQueries(input: {
  active: Accessor<boolean>
  sessionID: Accessor<string | undefined>
  pendingSessionStart?: Accessor<AgentSessionStartBinding | undefined>
  directory: Accessor<string>
  serverUrl?: Accessor<string | undefined>
  signedControlPlane?: Accessor<boolean | undefined>
  workspaceId?: Accessor<string | undefined>
  hostKind?: Accessor<RelayHostKind | undefined>
  sessionRef?: Accessor<SessionRef | undefined>
  fetchSessionRow?: (sessionID: string) => Promise<ClaxedoSession | undefined>
}) {
  const session = <T>(resource: string, options: (sessionID: string) => PaneQueryOptions<T>) => {
    if (!input.active()) return parkedPaneQueryOptions<T>(resource, "inactive")
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return parkedPaneQueryOptions<T>(resource, "no-session")
    return options(sessionID)
  }
  const statusQuery = useQuery<SessionStatus>(() => session("session-status", (sessionID) =>
    ({
      queryKey: shellDataKeys.sessionId(sessionID, "status"),
      queryFn: skipToken,
      enabled: false,
    })))
  const requestQuery = useQuery<SessionRequestsQueryData>(() => {
    const owner = input.pendingSessionStart?.()
    if (input.active() && owner) return {
      queryKey: shellDataKeys.sessionId(owner.sessionId, "requests"),
      queryFn: async () => ({
        permissions: [],
        questions: (await createAgentRuntimeClient({
          serverUrl: input.serverUrl?.(), signedControlPlane: input.signedControlPlane?.(),
          workspaceId: owner.workspaceId, hostKind: input.hostKind?.(),
        }).getStartingSessionQuestions({ directory: owner.directory, sessionID: owner.sessionId })).data.filter((question) => question.sessionID === owner.sessionId),
        reconciledAt: Date.now(),
      }),
    }
    return session("session-requests", (sessionID) => ({
      queryKey: shellDataKeys.sessionId(sessionID, "requests"), queryFn: skipToken, enabled: false,
    }))
  })
  const todoQuery = useQuery<Todo[]>(() => session("session-todo", (sessionID) =>
    ({
      queryKey: shellDataKeys.sessionId(sessionID, "todo"),
      queryFn: skipToken,
      enabled: false,
    })))
  const diffQuery = useQuery<SnapshotFileDiff[]>(() => session("session-diff", (sessionID) =>
    ({
      queryKey: shellDataKeys.sessionId(sessionID, "diff"),
      queryFn: skipToken,
      enabled: false,
    })))
  const authorityScope = (sessionID: string) => sessionResourceAuthorityScope({
    sessionID,
    directory: input.directory(),
    serverUrl: input.serverUrl?.(),
    signedControlPlane: input.signedControlPlane?.() ?? false,
    workspaceId: input.workspaceId?.(),
    hostKind: input.hostKind?.(),
    sessionRef: input.sessionRef?.(),
  })
  const capabilitiesQuery = useQuery<SessionTransportCapabilities>(() => session("session-capabilities", (sessionID) =>
    ({
      queryKey: sessionCapabilitiesKey(authorityScope(sessionID)),
      queryFn: skipToken,
      enabled: false,
    })))
  const goalQuery = useQuery<SessionGoalData>(() => session("session-goal", (sessionID) =>
    ({
      queryKey: sessionGoalKey(authorityScope(sessionID)),
      queryFn: skipToken,
      enabled: false,
    })))
  const directorySessionCacheQuery = useWorkspaceQuery(() => {
    if (!input.active()) return {
      ...parkedPaneQueryOptions<DirectorySessionCacheValue>("directory-session", "inactive"),
      workspaceId: undefined,
    }
    return {
      ...directorySessionCacheQueryOptions({ directory: input.directory() }),
      workspaceId: input.workspaceId?.(),
    }
  })
  const sessionRowQuery = useQuery<ClaxedoSession | null>(() => {
    if (!input.active()) return parkedPaneQueryOptions<ClaxedoSession | null>("session-row", "inactive")
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new" || !input.fetchSessionRow) {
      return parkedPaneQueryOptions<ClaxedoSession | null>("session-row", "no-session")
    }
    return ({
      queryKey: queryKeys.session.row(input.serverUrl?.(), input.directory(), sessionID),
      queryFn: async () => await input.fetchSessionRow!(sessionID) ?? null,
    })
  })

  return { statusQuery, requestQuery, todoQuery, diffQuery, capabilitiesQuery, goalQuery, directorySessionCacheQuery, sessionRowQuery }
}

export function sessionTodoTransportRequestKey(input: {
  sessionID: string
  directory: string
  signedControlPlane?: boolean
  workspaceId?: string
  hostKind?: RelayHostKind
}) {
  return shellDataKeys.sessionId(
    input.sessionID,
    "todo-request",
    input.directory,
    input.signedControlPlane === true ? "signed" : "local",
    input.workspaceId ?? "",
    input.hostKind ?? "",
  )
}

export function sessionTransportRequestKey(input: {
  sessionID: string
  directory: string
  before?: string
  view?: "latest-turn" | "latest-surface"
  limit?: number
  shouldFetchSession: boolean
  signedControlPlane?: boolean
  workspaceId?: string
  hostKind?: RelayHostKind
}) {
  return shellDataKeys.sessionId(
    input.sessionID,
    "transport-session-request",
    input.directory,
    input.before ?? "latest",
    input.view ?? "default",
    input.limit ?? "semantic",
    input.shouldFetchSession ? "with-session" : "messages-only",
    input.signedControlPlane === true ? "signed" : "local",
    input.workspaceId ?? "",
    input.hostKind ?? "",
  )
}
