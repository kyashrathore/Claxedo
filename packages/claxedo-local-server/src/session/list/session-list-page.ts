import { HTTPException } from "hono/http-exception"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
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
import { readRuntimeSessionActivity, type RuntimeSessionActivity, type RuntimeStatusRead } from "../runtime-activity"

export type SessionListPageInput = {
  query: SessionListQuery
  /** The workspace a workspace-scoped query names, once resolved. */
  workspace: Workspace | undefined
  /** The local workspaces whose sessions a project-scoped query covers. */
  projectWorkspaces: () => Promise<Workspace[]>
  refreshSessionProjection?: (workspace: Workspace) => Promise<void>
  /** What a workspace's mounted runtime reports right now, read in process. */
  readRuntimeStatus: RuntimeStatusRead
  now?: () => number
}

/**
 * The signed caller's page: the authority's keyset read, authorized per row
 * in the query itself, for the project or the one workspace the query names.
 */
export async function signedSessionListPage(
  authority: WorkspaceAuthority,
  auth: SignedControlPlaneAuth,
  input: Pick<SessionListPageInput, "query" | "workspace">,
): Promise<SessionListResponse> {
  const { query } = input
  const scope = query.scope === "project" && query.projectId
    ? { projectId: query.projectId }
    : input.workspace
      ? { workspaceId: input.workspace.id }
      : undefined
  if (!scope) throw new HTTPException(400, { message: "Name a project or a workspace" })
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
  const covered = query.scope === "project" && query.projectId && !input.workspace
    ? await input.projectWorkspaces()
    : input.workspace ? [input.workspace] : []
  await Promise.all(covered.map((workspace) => input.refreshSessionProjection?.(workspace)))
  const metas = await listSessionNavigationMetas({ ...sessionListStorePageFilter(query), reader: LOCAL_USER_ID })
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
