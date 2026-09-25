import { fetchQuery } from "./fetch-query"
import type { CloudApi } from "./api"
import { ServerError } from "./errors"
import type { PlacementId, ProjectId } from "./ids"
import { queryKeys } from "./query-keys"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { CloudWorkspace, CodeHostConnection, CodeHostRepository } from "./cloud-types"
import type { FetchQuery, Project } from "./types"
import { cloudWorkspaceFromRow, codeHostConnectionsFromWire, codeHostRepositoryFromRow } from "./wire/cloud"
import type { WorkspaceWakes } from "./workspace-wakes"
import type { Workspaces } from "./workspaces"

const INTEGRATIONS_PATH = "/api/claxedo/integrations"

export function cloudQueries(transport: Transport) {
  const server = transport.serverUrl
  const list = (): FetchQuery<readonly CloudWorkspace[]> => fetchQuery(queryKeys.cloud(server), async () => {
      const body = await transport.json<{ workspaces?: unknown }>(withQuery("/api/workspace", { host: "provisioner" }))
      return (Array.isArray(body.workspaces) ? body.workspaces : []).flatMap((row) => {
        const workspace = cloudWorkspaceFromRow(row)
        return workspace ? [workspace] : []
      })
    })
  const connections = (): FetchQuery<readonly CodeHostConnection[]> =>
    fetchQuery(queryKeys.codeHostConnections(server), async () => codeHostConnectionsFromWire(await transport.json<unknown>(INTEGRATIONS_PATH)))
  const repositories = (connectionId: string): FetchQuery<readonly CodeHostRepository[]> => fetchQuery(queryKeys.codeHostRepositories(server, connectionId), async () => {
      const body = await transport.json<{ repositories?: unknown }>(`${INTEGRATIONS_PATH}/connections/${encodeURIComponent(connectionId)}/repositories`)
      return (Array.isArray(body.repositories) ? body.repositories : []).flatMap((row) => {
        const repository = codeHostRepositoryFromRow(row)
        return repository ? [repository] : []
      })
    })
  return { cloud: { list }, codeHost: { connections, repositories } }
}

function sourceBody(project: Project) {
  const source = project.source
  if (source?.kind === "repository") return { repoUrl: source.url }
  if (source?.kind === "connectedRepository") return { connectionId: source.connectionId, repo: { fullName: source.fullName } }
  return {}
}

export function createCloudApi(transport: Transport, workspaces: Workspaces, wakes: WorkspaceWakes, project: (id: ProjectId) => Promise<Project>): CloudApi {
  const at = (id: PlacementId, suffix = "") => `/api/workspace/${encodeURIComponent(id)}${suffix}`
  return {
    create: async (options) => {
      const body = {
        projectId: options.projectId,
        ...(options.name ? { workspaceName: options.name } : {}),
        ...(options.branch ? { gitBranch: options.branch } : {}),
        ...sourceBody(await project(options.projectId)),
      }
      const created = await transport.json<Record<string, unknown>>("/api/workspace/create", jsonInit("POST", body))
      await workspaces.refresh()
      const workspace = cloudWorkspaceFromRow({ ...created, workspace_id: created.workspaceId, project_id: created.projectId ?? options.projectId })
      if (!workspace) throw new ServerError({ class: "internal", message: "The cloud workspace create answered without a workspace id" })
      return workspace
    },
    start: wakes.start,
    runtime: wakes.runtime,
    stop: async (id) => {
      await transport.json<unknown>(at(id, "/lifecycle/stop"), jsonInit("POST", {}))
    },
    remove: async (id) => {
      await transport.json<unknown>(at(id), { method: "DELETE" })
      await workspaces.refresh()
    },
  }
}
