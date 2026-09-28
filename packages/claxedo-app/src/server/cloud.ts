import type { HostedAccount } from "./account"
import { fetchQuery } from "./fetch-query"
import type { CloudApi } from "./api"
import { ServerError } from "./errors"
import { placementId, type PlacementId, type ProjectId } from "./ids"
import { queryKeys } from "./query-keys"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { CloudProjectCreateInput, CloudSourceCreateInput, CloudWorkspace, CodeHostRepository } from "./cloud-types"
import type { FetchQuery, Project, ProjectSource } from "./types"
import { cloudWorkspaceFromRow, codeHostRepositoryFromRow } from "./wire/cloud"
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
  const repositories = (connectionId: string): FetchQuery<readonly CodeHostRepository[]> => fetchQuery(queryKeys.codeHostRepositories(server, connectionId), async () => {
      const body = await transport.json<{ repositories?: unknown }>(`${INTEGRATIONS_PATH}/connections/${encodeURIComponent(connectionId)}/repositories`)
      return (Array.isArray(body.repositories) ? body.repositories : []).flatMap((row) => {
        const repository = codeHostRepositoryFromRow(row)
        return repository ? [repository] : []
      })
    })
  return { cloud: { list }, codeHost: { repositories } }
}

function sourceBody(source: ProjectSource | undefined) {
  if (source?.kind === "repository") return { repoUrl: source.url }
  if (source?.kind === "connectedRepository") return { connectionId: source.connectionId, repo: { fullName: source.fullName } }
  return {}
}

function accountSourceInput(source: CloudSourceCreateInput["source"]) {
  return source.kind === "repository" ? { repoUrl: source.url } : { connectionId: source.connectionId, repoFullName: source.fullName }
}

type Created = Readonly<Record<string, unknown>>

function createdWorkspace(created: Created, owner: ProjectId | undefined): CloudWorkspace {
  const workspace = cloudWorkspaceFromRow({ ...created, workspace_id: created.workspaceId, project_id: created.projectId ?? owner })
  if (!workspace) throw new ServerError({ class: "internal", message: "The cloud workspace create answered without a workspace or its project" })
  return workspace
}

function createForProject(transport: Transport, workspaces: Workspaces, project: (id: ProjectId) => Promise<Project>) {
  return async (options: CloudProjectCreateInput) => {
    const body = {
      projectId: options.projectId,
      ...(options.name ? { workspaceName: options.name } : {}),
      ...(options.branch ? { gitBranch: options.branch } : {}),
      ...sourceBody((await project(options.projectId)).source),
    }
    const created = await transport.json<Created>("/api/workspace/create", jsonInit("POST", body))
    await workspaces.refresh()
    return createdWorkspace(created, options.projectId)
  }
}

function createForSource(workspaces: Workspaces, account: HostedAccount | undefined) {
  return async (options: CloudSourceCreateInput) => {
    if (!account) throw new ServerError({ class: "invalid", message: "A repository's cloud workspace is created on a signed control plane, and this app has none" })
    const created: Created = await account.run("workspace.create", { ...(options.name ? { workspaceName: options.name } : {}), ...accountSourceInput(options.source) })
    await workspaces.refresh()
    const id = typeof created.workspaceId === "string" ? placementId(created.workspaceId) : undefined
    return createdWorkspace(created, id ? workspaces.byId(id)?.projectId : undefined)
  }
}

export function createCloudApi(
  transport: Transport,
  workspaces: Workspaces,
  wakes: WorkspaceWakes,
  project: (id: ProjectId) => Promise<Project>,
  account: HostedAccount | undefined,
): CloudApi {
  const at = (id: PlacementId, suffix = "") => `/api/workspace/${encodeURIComponent(id)}${suffix}`
  const forProject = createForProject(transport, workspaces, project)
  const forSource = createForSource(workspaces, account)
  return {
    create: (options) => ("source" in options ? forSource(options) : forProject(options)),
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
