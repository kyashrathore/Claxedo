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
import type { AgentRuntimeDirectory } from "@/platform/runtime/agent/agent-runtime-client"
import { paneQueryOptions, parkedPaneQueryOptions } from "./pane-query-observer"
import { sessionGoalKey, type SessionGoalData } from "./session-goal-query"
import { queryKeys } from "@/platform/query/keys"
import type { ClaxedoSession } from "../data/session-types"
import {
  sessionResourceAuthorityKey,
  sessionResourceAuthorityScope,
  type SessionResourceAuthorityScope,
} from "./session-resource-authority"

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
  directory: Accessor<string>
  serverUrl?: Accessor<string | undefined>
  signedControlPlane?: Accessor<boolean | undefined>
  workspaceId?: Accessor<string | undefined>
  workspaceKind?: Accessor<"cloud" | "user-hosted" | undefined>
  sessionRef?: Accessor<SessionRef | undefined>
  fetchSessionRow?: (sessionID: string) => Promise<ClaxedoSession | undefined>
}) {
  const session = <T>(resource: string, options: (sessionID: string) => ReturnType<typeof paneQueryOptions<T>>) => {
    if (!input.active()) return parkedPaneQueryOptions<T>(resource, "inactive")
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return parkedPaneQueryOptions<T>(resource, "no-session")
    return options(sessionID)
  }
  const statusQuery = useQuery<SessionStatus>(() => session("session-status", (sessionID) =>
    paneQueryOptions<SessionStatus>({
      queryKey: shellDataKeys.sessionId(sessionID, "status"),
      queryFn: skipToken,
      enabled: false,
    })))
  const requestQuery = useQuery<SessionRequestsQueryData>(() => session("session-requests", (sessionID) =>
    paneQueryOptions<SessionRequestsQueryData>({
      queryKey: shellDataKeys.sessionId(sessionID, "requests"),
      queryFn: skipToken,
      enabled: false,
    })))
  const todoQuery = useQuery<Todo[]>(() => session("session-todo", (sessionID) =>
    paneQueryOptions<Todo[]>({
      queryKey: shellDataKeys.sessionId(sessionID, "todo"),
      queryFn: skipToken,
      enabled: false,
    })))
  const diffQuery = useQuery<SnapshotFileDiff[]>(() => session("session-diff", (sessionID) =>
    paneQueryOptions<SnapshotFileDiff[]>({
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
    workspaceKind: input.workspaceKind?.(),
    sessionRef: input.sessionRef?.(),
  })
  const capabilitiesQuery = useQuery<SessionTransportCapabilities>(() => session("session-capabilities", (sessionID) =>
    paneQueryOptions<SessionTransportCapabilities>({
      queryKey: sessionCapabilitiesKey(authorityScope(sessionID)),
      queryFn: skipToken,
      enabled: false,
    })))
  const goalQuery = useQuery<SessionGoalData>(() => session("session-goal", (sessionID) =>
    paneQueryOptions<SessionGoalData>({
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
    const sessionRef = input.sessionRef?.()
    if (!sessionID || sessionID === "new" || sessionRef?.host !== "central" || !input.fetchSessionRow) {
      return parkedPaneQueryOptions<ClaxedoSession | null>("session-row", "no-session")
    }
    return paneQueryOptions<ClaxedoSession | null>({
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
  workspaceKind?: "cloud" | "user-hosted"
}) {
  return shellDataKeys.sessionId(
    input.sessionID,
    "todo-request",
    input.directory,
    input.signedControlPlane === true ? "signed" : "local",
    input.workspaceId ?? "",
    input.workspaceKind ?? "",
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
  workspaceKind?: "cloud" | "user-hosted"
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
    input.workspaceKind ?? "",
  )
}
