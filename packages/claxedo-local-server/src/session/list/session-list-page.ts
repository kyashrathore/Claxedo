import { HTTPException } from "hono/http-exception"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { sessionPageScope } from "@claxedo/server-core/platform/auth/private-session-authority"
import { LOCAL_USER_ID } from "@claxedo/server-core/platform/auth/local-identity"
import { listSessionNavigationMetas } from "@claxedo/server-core/session/meta/index"
import {
  buildSessionListResponse,
  sessionListKeysetPage,
  sessionListStorePageFilter,
  type SessionListQuery,
  type SessionListResponse,
} from "@claxedo/server-core/session/navigation-list"
import type { SessionMeta } from "@claxedo/server-core/session/meta/index"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { readRuntimeSessionActivity, type RuntimeSessionActivity, type RuntimeStatusRead } from "@claxedo/server-core/session/runtime-activity"

export type SessionListPageInput = {
  query: SessionListQuery
  /** The workspace a workspace-scoped query names, once resolved. */
  workspace: Workspace | undefined
  /** The local workspaces whose sessions a project-scoped or an all-scoped query covers. */
  coveredWorkspaces: () => Promise<Workspace[]>
  refreshSessionProjection?: (workspace: Workspace) => Promise<void>
  /** What a workspace's mounted runtime reports right now, read in process. */
  readRuntimeStatus: RuntimeStatusRead
  now?: () => number
}

/**
 * The signed caller's page: the authority's keyset read, authorized per row
 * in the query itself, for the project, the one workspace or every session
 * the query names.
 */
export async function signedSessionListPage(
  authority: WorkspaceAuthority,
  auth: SignedControlPlaneAuth,
  input: Pick<SessionListPageInput, "query" | "workspace">,
): Promise<SessionListResponse> {
  const { query } = input
  const scope = sessionPageScope(query, input.workspace?.id)
  if (!scope) throw new HTTPException(400, { message: "Name a project, a workspace or every session" })
  const sessions = await authority.listSessionPage(auth, { ...sessionListKeysetPage(query), ...scope })
  return buildSessionListResponse({
    query: "workspaceId" in scope ? { ...query, workspaceId: scope.workspaceId } : query,
    sessions,
    cursorApplied: true,
  })
}

/**
 * This machine's page, from its own projection. The projection of every
 * workspace the query covers is reconciled against its runtime first, once
 * per process, so a session the runtime holds is listed before it is next
 * written. Each row carries the status its runtime holds as the page is
 * read, so a reader needs no status read of its own; events move it on.
 */
export async function localSessionListPage(input: SessionListPageInput): Promise<SessionListResponse> {
  const { query } = input
  const broad = query.scope === "all" || (query.scope === "project" && query.projectId)
  const covered = broad && !input.workspace
    ? await input.coveredWorkspaces()
    : input.workspace ? [input.workspace] : []
  const refresh = input.refreshSessionProjection
  if (refresh) await Promise.all(covered.map((workspace) => refresh(workspace)))
  const live = query.scope === "all" ? { workspaceIDs: covered.map((workspace) => workspace.id) } : {}
  const metas = await listSessionNavigationMetas({ ...sessionListStorePageFilter(query), ...live, reader: LOCAL_USER_ID })
  return buildSessionListResponse({
    query,
    sessions: await withRuntimeStatus(metas, input.readRuntimeStatus, (input.now ?? Date.now)()),
    cursorApplied: true,
  })
}

async function withRuntimeStatus(metas: readonly SessionMeta[], read: RuntimeStatusRead, at: number) {
  const workspaceIds = [...new Set(metas.flatMap((meta) => (meta.workspaceID ? [meta.workspaceID] : [])))]
  const activity = new Map(await Promise.all(workspaceIds.map(async (workspaceId) =>
    [workspaceId, await readRuntimeSessionActivity(read, workspaceId).catch(() => undefined)] as const)))
  return metas.map((meta) => {
    const read = meta.workspaceID ? activity.get(meta.workspaceID) : undefined
    const session: RuntimeSessionActivity | undefined = read?.get(meta.sessionID)
    const background = session?.backgroundWork ? { backgroundWork: session.backgroundWork } : {}
    return { ...meta, status: { kind: session?.kind ?? "idle", awaitingInput: (session?.pending.size ?? 0) > 0, ...background, at } }
  })
}
