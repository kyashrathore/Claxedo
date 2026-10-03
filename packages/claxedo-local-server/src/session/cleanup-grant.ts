import { createWorkspaceRuntimeClient } from "@claxedo/workspace-runtime/client"
import { inProcessFetch, type SessionCleanupGrant } from "@claxedo/mcp"
import { SessionCleanupRoutes } from "@claxedo/server-core/session/cleanup-routes"
import { prepareRuntimeSessionCleanup, deleteRuntimeSessionCleanup } from "@claxedo/server-core/session/cleanup-runtime"
import { listWorkspaces } from "@claxedo/server-core/workspace/store/index"
import { admitLocalSessionCleanup } from "./cleanup-reader"
import { localSessionListPage } from "./list/session-list-page"
import { readMountedEmbeddedWorkspaceRuntime } from "../deployments/local/embedded-workspace-runtime"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"

export function localSessionCleanupGrant(input: {
  ownerDriven(): boolean
  fetch(request: Request): Promise<Response> | Response
  refreshSessionProjection?: (workspace: Workspace) => Promise<void>
  excludeWorkspaces?(): Promise<readonly string[]>
}): SessionCleanupGrant {
  const requireOwner = () => {
    if (!input.ownerDriven()) throw new ClaxedoError({ status: 403, code: "cleanup_capability_revoked", message: "This session is no longer driven exclusively by the machine's owner" })
  }
  const server = (workspaceId: string) => createWorkspaceRuntimeClient({
    baseUrl: "http://127.0.0.1",
    workspace: workspaceId,
    fetch: async (request, init) => {
      const call = new Request(request, init)
      call.headers.set("x-workspace-id", workspaceId)
      // This is the last boundary before the in-process runtime dispatch.
      if (!input.ownerDriven()) return Response.json({ error: { code: "cleanup_capability_revoked" } }, { status: 403 })
      return input.fetch(call)
    },
  })
  const routes = SessionCleanupRoutes({
    authenticate: async () => {
      if (!input.ownerDriven()) return Response.json({ error: { code: "cleanup_capability_revoked", message: "This session is no longer driven exclusively by the machine's owner" } }, { status: 403 })
      return {
        list: async (query) => {
          requireOwner()
          const allWorkspaces = await listWorkspaces()
          const excluded = await input.excludeWorkspaces?.() ?? []
          const workspaces = allWorkspaces.filter((row) => row.kind !== "cloud" && !excluded.includes(row.id))
          const scoped = workspaces.filter((row) => !query.workspaceId || row.id === query.workspaceId)
          const incompleteSources = []
          for (const workspace of scoped) {
            if (!await readMountedEmbeddedWorkspaceRuntime(workspace.id, "/session/status")) {
              incompleteSources.push({ workspaceId: workspace.id, reason: "Session runtime is unavailable" })
            }
          }
          const page = await localSessionListPage({
            query: { ...query, excludeWorkspaces: [...query.excludeWorkspaces ?? [], ...excluded] }, workspace: scoped.length === 1 && query.workspaceId ? scoped[0] : undefined,
            projectWorkspaces: async () => scoped,
            readRuntimeStatus: readMountedEmbeddedWorkspaceRuntime,
            ...(input.refreshSessionProjection ? { refreshSessionProjection: input.refreshSessionProjection } : {}),
          })
          return { ...page, incompleteSources }
        },
        prepare: async (row) => {
          if (!await readMountedEmbeddedWorkspaceRuntime(row.workspaceId!, "/session/status")) return { unavailable: "Session runtime is unavailable" }
          return prepareRuntimeSessionCleanup(server(row.workspaceId!), row)
        },
        admit: async (target) => { requireOwner(); admitLocalSessionCleanup(target) },
        delete: (target) => { requireOwner(); return deleteRuntimeSessionCleanup(server(target.workspaceId), target) },
      }
    },
  })
  return { allowed: () => input.ownerDriven(), fetch: inProcessFetch((request) => routes.fetch(request)) }
}
