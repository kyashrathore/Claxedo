import type { QueryClient } from "@tanstack/solid-query"
import { fetchQuery } from "./fetch-query"
import type { ProjectId } from "./ids"
import type { ProjectsApi } from "./api"
import { queryKeys } from "./query-keys"
import { jsonInit, type Transport } from "./transport"
import type { FetchQuery, Project } from "./types"
import type { Workspaces } from "./workspaces"
import { ServerError } from "./errors"
import { oneProjectFromWire, projectsFromWire, projectSourceBody } from "./wire/projects"

const PROJECTS_PATH = "/api/claxedo/projects"

function projectPath(id: ProjectId) {
  return `${PROJECTS_PATH}/${encodeURIComponent(id)}`
}

export function projectQueries(transport: Transport, workspaces: Pick<Workspaces, "accountProjects" | "load">) {
  const list = async () => {
    await workspaces.load()
    if (transport.serverKind() === "hosted") return workspaces.accountProjects()
    const [local, account] = await Promise.all([transport.json<unknown>(PROJECTS_PATH), workspaces.accountProjects()])
    return [...projectsFromWire(local), ...account]
  }
  const byId = async (id: ProjectId) => {
    await workspaces.load()
    const account = (await workspaces.accountProjects()).find((project) => project.id === id)
    if (!account && transport.serverKind() === "hosted") throw new ServerError({ class: "not_found", message: `Project ${id} is not in the account catalog` })
    return account ?? oneProjectFromWire(await transport.json<unknown>(projectPath(id)))
  }
  return {
    list: (): FetchQuery<readonly Project[]> => fetchQuery(queryKeys.projects(transport.serverUrl), list),
    byId: (id: ProjectId): FetchQuery<Project> => fetchQuery(queryKeys.project(transport.serverUrl, id), () => byId(id)),
  }
}

function projectCache(queryClient: QueryClient, serverUrl: string) {
  return (project: Project) => {
    queryClient.setQueryData(queryKeys.project(serverUrl, project.id), project)
    queryClient.setQueryData<readonly Project[]>(queryKeys.projects(serverUrl), (current) =>
      current && [...current.filter((item) => item.id !== project.id), project].sort((a, b) => a.createdAt - b.createdAt),
    )
  }
}

export function createProjectsApi(transport: Transport, queryClient: QueryClient, workspaces: Pick<Workspaces, "load" | "refresh">): ProjectsApi {
  const remember = projectCache(queryClient, transport.serverUrl)
  const configurationAvailable = () => transport.serverKind() === "daemon"
  const requireConfiguration = async () => {
    await workspaces.load()
    if (!configurationAvailable()) throw new ServerError({ class: "invalid", code: "project_configuration_unavailable", message: "Project configuration requires a daemon" })
  }
  return {
    configurationAvailable,
    create: async (input) => {
      await requireConfiguration()
      const body = { source: projectSourceBody(input.source), ...(input.name ? { name: input.name } : {}) }
      const project = oneProjectFromWire(await transport.json<unknown>(PROJECTS_PATH, jsonInit("POST", body)))
      remember(project)
      await workspaces.refresh()
      return project
    },
    update: async (id, patch) => {
      await requireConfiguration()
      const project = oneProjectFromWire(await transport.json<unknown>(projectPath(id), jsonInit("PATCH", patch)))
      remember(project)
      return project
    },
    remove: async (id) => {
      await requireConfiguration()
      await transport.json<unknown>(projectPath(id), { method: "DELETE" })
      queryClient.removeQueries({ queryKey: queryKeys.project(transport.serverUrl, id) })
      queryClient.setQueryData<readonly Project[]>(queryKeys.projects(transport.serverUrl), (current) => current?.filter((item) => item.id !== id))
      await workspaces.refresh()
    },
    reclone: async (id) => {
      await requireConfiguration()
      const project = oneProjectFromWire(await transport.json<unknown>(`${projectPath(id)}/reclone`, { method: "POST" }))
      remember(project)
      await workspaces.refresh()
      return project
    },
  }
}
