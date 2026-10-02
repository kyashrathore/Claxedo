import { createSignal } from "solid-js"
import { QueryObserver, type QueryClient } from "@tanstack/solid-query"
import type { HostedAccount } from "./account"
import { placementId, projectId, sessionId } from "./ids"
import { queryKeys } from "./query-keys"
import type { RuntimeRoute } from "./transport"
import type { SessionLocation, SharedSessionRow } from "./types"

type SessionRef = Pick<SessionLocation, "placementId" | "sessionId">

export type SharedSessions = ReturnType<typeof createSharedSessions>

export function createSharedSessions(account: HostedAccount | undefined, serverUrl: string, client: QueryClient) {
  const key = queryKeys.sharedSessions(serverUrl)
  const read = async (): Promise<readonly SharedSessionRow[]> => {
    if (!account) return []
    return (await account.run("session.shared.list")).sessions.map((row) => ({
      ref: { placementId: placementId(row.workspace_id), projectId: projectId(row.project_id), sessionId: sessionId(row.session_id) },
      title: row.title,
      ownerName: row.owner_name,
      level: row.level,
    }))
  }
  const [revision, revise] = createSignal(0)
  const dispose = new QueryObserver(client, { queryKey: key, queryFn: read, enabled: account !== undefined, staleTime: Number.POSITIVE_INFINITY, retry: false })
    .subscribe(() => revise((value) => value + 1))
  const list = () => {
    revision()
    return client.getQueryData<readonly SharedSessionRow[]>(key) ?? []
  }
  const find = (ref: SessionRef) => list().find((row) => row.ref.placementId === ref.placementId && row.ref.sessionId === ref.sessionId)
  const route = (ref: SessionRef): RuntimeRoute | undefined => {
    const row = find(ref)
    return row && { directory: `workspace:${row.ref.placementId}`, workspaceId: row.ref.placementId, remote: true, sharedSession: { sessionId: row.ref.sessionId, level: row.level } }
  }
  return {
    enabled: account !== undefined,
    error: () => {
      revision()
      return client.getQueryState(key)?.error ?? undefined
    },
    list,
    find,
    route,
    load: async () => {
      await client.fetchQuery({ queryKey: key, queryFn: read, staleTime: Number.POSITIVE_INFINITY })
    },
    refresh: () => client.invalidateQueries({ queryKey: key }),
    dispose,
  }
}
