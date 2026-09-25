import { HTTPException } from "hono/http-exception"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { listSessionMetas, listSessionNavigationMetas } from "@claxedo/server-core/session/meta/index"
import {
  buildSessionListResponse,
  sessionListIsKeysetPageable,
  sessionListKeysetPage,
  sessionListStoreFilter,
  sessionListStorePageFilter,
  type SessionListQuery,
  type SessionListResponse,
} from "@claxedo/server-core/session/navigation-list"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { readMergedSessionListPage, type SessionListSource } from "./merged-session-page"

export type SessionListPageInput = {
  query: SessionListQuery
  /** The workspace a workspace-scoped query names, once resolved. */
  workspace: Workspace | undefined
  /** The local workspaces whose sessions a project-scoped query covers. */
  projectWorkspaces: () => Promise<Workspace[]>
  refreshSessionProjection?: (workspace: Workspace) => Promise<void>
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
  if (!sessionListIsKeysetPageable(query)) {
    throw new HTTPException(400, { message: "The signed session list is flat and unfiltered by environment or git" })
  }
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
 * written.
 */
export async function localSessionListPage(input: SessionListPageInput): Promise<SessionListResponse> {
  const { query } = input
  const covered = query.scope === "project" && query.projectId && !input.workspace
    ? await input.projectWorkspaces()
    : input.workspace ? [input.workspace] : []
  await Promise.all(covered.map((workspace) => input.refreshSessionProjection?.(workspace)))
  if (!sessionListIsKeysetPageable(query)) {
    return buildSessionListResponse({ query, sessions: await listSessionMetas(sessionListStoreFilter(query)) })
  }
  return await readMergedSessionListPage(query, [localProjectionSource(query)])
}

function localProjectionSource(query: SessionListQuery): SessionListSource {
  return {
    name: "local",
    required: true,
    read: async () => await listSessionNavigationMetas(sessionListStorePageFilter(query)),
  }
}
