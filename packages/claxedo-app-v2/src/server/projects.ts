import type { QueryClient } from "@tanstack/solid-query"
import { fetchQuery } from "./fetch-query"
import type { ProjectId } from "./ids"
import type { ProjectsApi } from "./api"
import { queryKeys } from "./query-keys"
import { jsonInit, type Transport } from "./transport"
import type { FetchQuery, Project } from "./types"
import type { Workspaces } from "./workspaces"
import { oneProjectFromWire, projectsFromWire, projectSourceBody } from "./wire/projects"

const PROJECTS_PATH = "/api/claxedo/projects"

function projectPath(id: ProjectId) {
  return `${PROJECTS_PATH}/${encodeURIComponent(id)}`
}

export function projectQueries(transport: Transport, workspaces: Pick<Workspaces, "accountProjects">) {
  const list = async () => {
    const [local, account] = await Promise.all([transport.json<unknown>(PROJECTS_PATH), workspaces.accountProjects()])
    return [...projectsFromWire(local), ...account]
  }
  const byId = async (id: ProjectId) => {
    const account = (await workspaces.accountProjects()).find((project) => project.id === id)
    return account ?? oneProjectFromWire(await transport.json<unknown>(projectPath(id)))
  }
  return {
    list: (): FetchQuery<readonly Project[]> => fetchQuery(queryKeys.projects(transport.serverUrl), list),
    byId: (id: ProjectId): FetchQuery<Project> => fetchQuery(queryKeys.project(transport.serverUrl, id), () => byId(id)),
  }
}

export function createProjectsApi(transport: Transport, queryClient: QueryClient, placementsChanged: () => Promise<void>): ProjectsApi {
  const remember = (project: Project) => {
    queryClient.setQueryData(queryKeys.project(transport.serverUrl, project.id), project)
    queryClient.setQueryData<readonly Project[]>(queryKeys.projects(transport.serverUrl), (current) =>
      current && [...current.filter((item) => item.id !== project.id), project].sort((a, b) => a.createdAt - b.createdAt),
    )
  }
  return {
    create: async (input) => {
      const body = { source: projectSourceBody(input.source), ...(input.name ? { name: input.name } : {}) }
      const project = oneProjectFromWire(await transport.json<unknown>(PROJECTS_PATH, jsonInit("POST", body)))
      remember(project)
      await placementsChanged()
      return project
    },
    update: async (id, patch) => {
      const project = oneProjectFromWire(await transport.json<unknown>(projectPath(id), jsonInit("PATCH", patch)))
      remember(project)
      return project
    },
    remove: async (id) => {
      await transport.json<unknown>(projectPath(id), { method: "DELETE" })
      queryClient.removeQueries({ queryKey: queryKeys.project(transport.serverUrl, id) })
      queryClient.setQueryData<readonly Project[]>(queryKeys.projects(transport.serverUrl), (current) => current?.filter((item) => item.id !== id))
      await placementsChanged()
    },
  }
}
