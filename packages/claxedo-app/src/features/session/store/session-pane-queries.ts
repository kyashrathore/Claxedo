import { useQuery } from "@tanstack/solid-query"
import type { Accessor } from "solid-js"
import { useSDK, useWorkspaceQuery } from "@/features/session/app-ports"
import { shellDataKeys } from "@/platform/sync/keys"
import {
  directorySessionCacheQueryOptions,
  type DirectorySessionCacheValue,
  type SessionRequestsQueryData,
  type SessionStatus,
  type SnapshotFileDiff,
  type Todo,
  sessionDiffQueryOptions,
  sessionRequestsQueryOptions,
  sessionStatusQueryOptions,
  sessionTodoQueryOptions,
} from "../data/sync/queries"
import {
  DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES,
  type SessionTransportCapabilities,
} from "./session-transport"
import { paneQueryOptions, parkedPaneQueryOptions } from "./pane-query-observer"

export function sessionCapabilitiesKey(sessionID: string) {
  return shellDataKeys.sessionId(sessionID, "transport-capabilities")
}

export function createSessionPaneQueries(input: {
  active: Accessor<boolean>
  sessionID: Accessor<string | undefined>
  directory: Accessor<string>
  workspaceId?: Accessor<string | undefined>
}) {
  const sdk = useSDK()
  const session = <T>(resource: string, options: (sessionID: string) => ReturnType<typeof paneQueryOptions<T>>) => {
    if (!input.active()) return parkedPaneQueryOptions<T>(resource, "inactive")
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return parkedPaneQueryOptions<T>(resource, "no-session")
    return options(sessionID)
  }
  const statusQuery = useQuery<SessionStatus>(() => session("session-status", (sessionID) =>
    paneQueryOptions<SessionStatus>({ ...sessionStatusQueryOptions({ sessionId: sessionID, client: sdk.client }), enabled: false })))
  const requestQuery = useQuery<SessionRequestsQueryData>(() => session("session-requests", (sessionID) =>
    paneQueryOptions<SessionRequestsQueryData>({ ...sessionRequestsQueryOptions({ sessionId: sessionID, client: sdk.client }), enabled: false })))
  const todoQuery = useQuery<Todo[]>(() => session("session-todo", (sessionID) =>
    paneQueryOptions<Todo[]>({ ...sessionTodoQueryOptions({ sessionId: sessionID, client: sdk.client }), enabled: false })))
  const diffQuery = useQuery<SnapshotFileDiff[]>(() => session("session-diff", (sessionID) =>
    paneQueryOptions<SnapshotFileDiff[]>({ ...sessionDiffQueryOptions({ sessionId: sessionID, client: sdk.client }), enabled: false })))
  const capabilitiesQuery = useQuery<SessionTransportCapabilities>(() => session("session-capabilities", (sessionID) =>
    paneQueryOptions<SessionTransportCapabilities>({
      queryKey: sessionCapabilitiesKey(sessionID),
      queryFn: async () => DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES,
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

  return { statusQuery, requestQuery, todoQuery, diffQuery, capabilitiesQuery, directorySessionCacheQuery }
}
