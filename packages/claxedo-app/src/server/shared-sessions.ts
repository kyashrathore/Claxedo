import { createSignal } from "solid-js"
import { QueryObserver, type QueryClient } from "@tanstack/solid-query"
import type { SharedSession } from "@claxedo/account-contract"
import type { HostedAccount } from "./account"
import { placementId, projectId, sessionId } from "./ids"
import { queryKeys } from "./query-keys"
import type { RuntimeRoute } from "./transport"
import type { SessionLocation, SharedSessionRow } from "./types"

type SessionRef = Pick<SessionLocation, "placementId" | "sessionId">

export type SharedSessions = ReturnType<typeof createSharedSessions>

function sharedSessionRow(row: SharedSession): SharedSessionRow {
  return {
    ref: { placementId: placementId(row.workspace_id), projectId: projectId(row.project_id), sessionId: sessionId(row.session_id) },
    title: row.title,
    ownerName: row.owner_name,
    level: row.level,
  }
}

function sharedRoute(row: SharedSessionRow): RuntimeRoute {
  return { directory: `workspace:${row.ref.placementId}`, workspaceId: row.ref.placementId, remote: true, sharedSession: { sessionId: row.ref.sessionId, level: row.level } }
}

export function createSharedSessions(account: HostedAccount | undefined, serverUrl: string, client: QueryClient) {
  const key = queryKeys.sharedSessions(serverUrl)
  const read = async () => (account ? (await account.run("session.shared.list")).sessions.map(sharedSessionRow) : [])
  const [revision, revise] = createSignal(0)
  const dispose = new QueryObserver(client, { queryKey: key, queryFn: read, enabled: account !== undefined, staleTime: Number.POSITIVE_INFINITY, retry: false })
    .subscribe(() => revise((value) => value + 1))
  const state = () => {
    revision()
    return client.getQueryState<readonly SharedSessionRow[]>(key)
  }
  const list = () => state()?.data ?? []
  const find = (ref: SessionRef) => list().find((row) => row.ref.placementId === ref.placementId && row.ref.sessionId === ref.sessionId)
  return {
    enabled: account !== undefined,
    error: () => state()?.error ?? undefined,
    count: () => (!account ? 0 : !state() || state()?.status === "pending" ? undefined : list().length),
    list,
    find,
    route: (ref: SessionRef): RuntimeRoute | undefined => {
      const row = find(ref)
      return row && sharedRoute(row)
    },
    load: async () => {
      await client.fetchQuery({ queryKey: key, queryFn: read, staleTime: Number.POSITIVE_INFINITY })
    },
    refresh: () => client.invalidateQueries({ queryKey: key }),
    dispose,
  }
}
