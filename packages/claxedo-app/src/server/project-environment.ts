import type { QueryClient } from "@tanstack/solid-query"
import type { HostedAccount } from "./account"
import { fetchQuery } from "./fetch-query"
import type { ProjectId } from "./ids"
import { queryKeys } from "./query-keys"
import { jsonInit, type Transport } from "./transport"
import type { FetchQuery, ProjectEnvironment } from "./types"
import type { Workspaces } from "./workspaces"
import { projectEnvironmentFromWire } from "./wire/projects"

type Reach = Pick<Workspaces, "accountProjects" | "accountProjectIds">

function environmentPath(id: ProjectId, name?: string) {
  return `/api/claxedo/projects/${encodeURIComponent(id)}/environment${name ? `/${encodeURIComponent(name)}` : ""}`
}

function projectEnvironmentRoute(transport: Transport, workspaces: Reach, account: HostedAccount | undefined) {
  const accountProject = async (id: ProjectId) => {
    if (!account) return undefined
    await workspaces.accountProjects()
    return workspaces.accountProjectIds(id)[0]
  }
  return {
    read: async (id: ProjectId) => {
      const projectId = await accountProject(id)
      return projectEnvironmentFromWire(projectId && account
        ? await account.run("project.environment.list", { projectId })
        : await transport.json(environmentPath(id)))
    },
    set: async (id: ProjectId, name: string, value: string) => {
      const projectId = await accountProject(id)
      return projectEnvironmentFromWire(projectId && account
        ? await account.run("project.environment.set", { projectId, name, value })
        : await transport.json(environmentPath(id, name), jsonInit("PUT", { value })))
    },
    remove: async (id: ProjectId, name: string) => {
      const projectId = await accountProject(id)
      return projectEnvironmentFromWire(projectId && account
        ? await account.run("project.environment.remove", { projectId, name })
        : await transport.json(environmentPath(id, name), { method: "DELETE" }))
    },
  }
}

export function projectEnvironmentQuery(transport: Transport, workspaces: Reach, account: HostedAccount | undefined) {
  const route = projectEnvironmentRoute(transport, workspaces, account)
  return (id: ProjectId): FetchQuery<ProjectEnvironment> => fetchQuery(queryKeys.projectEnvironment(transport.serverUrl, id), () => route.read(id))
}

export type ProjectEnvironmentApi = {
  readonly setVariable: (id: ProjectId, name: string, value: string) => Promise<ProjectEnvironment>
  readonly removeVariable: (id: ProjectId, name: string) => Promise<ProjectEnvironment>
}

export function createProjectEnvironmentApi(transport: Transport, queryClient: QueryClient, workspaces: Reach, account: HostedAccount | undefined): ProjectEnvironmentApi {
  const route = projectEnvironmentRoute(transport, workspaces, account)
  const remember = (id: ProjectId) => (environment: ProjectEnvironment) => {
    queryClient.setQueryData(queryKeys.projectEnvironment(transport.serverUrl, id), environment)
    return environment
  }
  return {
    setVariable: async (id, name, value) => remember(id)(await route.set(id, name, value)),
    removeVariable: async (id, name) => remember(id)(await route.remove(id, name)),
  }
}
