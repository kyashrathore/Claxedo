import type { QueryClient } from "@tanstack/solid-query"
import { fetchQuery } from "./fetch-query"
import type { ProjectId } from "./ids"
import type { ProjectsApi } from "./api"
import { queryKeys } from "./query-keys"
import { jsonInit, type Transport } from "./transport"
import type { FetchQuery, Project } from "./types"
import type { CloudSourceCreateInput, CloudWorkspace } from "./cloud-types"
import type { Workspaces } from "./workspaces"
import { ServerError } from "./errors"
import { repositoryName } from "./repository-name"
import { oneProjectFromWire, projectsFromWire, projectSourceBody } from "./wire/projects"

const PROJECTS_PATH = "/api/claxedo/projects"

function projectPath(id: ProjectId) {
  return `${PROJECTS_PATH}/${encodeURIComponent(id)}`
}

export function projectQueries(transport: Transport, workspaces: Pick<Workspaces, "accountProjects" | "load">) {
  const hosted = async () => (await workspaces.load()).declaration.serverKind === "hosted"
  const list = async () => {
    if (await hosted()) return workspaces.accountProjects()
    const [local, account] = await Promise.all([transport.json(PROJECTS_PATH), workspaces.accountProjects()])
    return [...projectsFromWire(local), ...account]
  }
  const byId = async (id: ProjectId) => {
    const account = (await workspaces.accountProjects()).find((project) => project.id === id)
    if (!account && (await hosted())) throw new ServerError({ class: "not_found", message: `Project ${id} is not in the account catalog` })
    return account ?? oneProjectFromWire(await transport.json(projectPath(id)))
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

type CreateCloudWorkspace = (input: CloudSourceCreateInput) => Promise<CloudWorkspace>

type ProjectCreateInput = Parameters<ProjectsApi["create"]>[0]

function hostedProjectCreator(workspaces: Pick<Workspaces, "accountProjects">, createCloudWorkspace: CreateCloudWorkspace) {
  return async (input: ProjectCreateInput): Promise<Project> => {
    const source = input.source
    if (source.kind === "folder") throw new ServerError({ class: "invalid", code: "project_folder_unavailable", message: "A hosted plane holds no folders; a project here is made from a repository" })
    const workspace = await createCloudWorkspace({ source, name: input.name ?? repositoryName(source), ...(input.onPlacement ? { onCreated: input.onPlacement } : {}) })
    const project = (await workspaces.accountProjects()).find((candidate) => candidate.id === workspace.projectId)
    if (!project) throw new ServerError({ class: "internal", message: `The catalog does not list project ${workspace.projectId} of the new workspace ${workspace.id}` })
    return project
  }
}

function daemonProjectCreator(transport: Transport, workspaces: Pick<Workspaces, "refresh">) {
  return async (input: ProjectCreateInput): Promise<Project> => {
    const body = { source: projectSourceBody(input.source), ...(input.name ? { name: input.name } : {}) }
    const project = oneProjectFromWire(await transport.json(PROJECTS_PATH, jsonInit("POST", body)))
    await workspaces.refresh()
    return project
  }
}

function projectConfiguration(
  transport: Transport,
  queryClient: QueryClient,
  workspaces: Pick<Workspaces, "refresh">,
  remember: (project: Project) => void,
  requireConfiguration: () => Promise<void>,
): Pick<ProjectsApi, "update" | "remove" | "reclone"> {
  return {
    update: async (id, patch) => {
      await requireConfiguration()
      const project = oneProjectFromWire(await transport.json(projectPath(id), jsonInit("PATCH", patch)))
      remember(project)
      return project
    },
    remove: async (id) => {
      await requireConfiguration()
      await transport.json(projectPath(id), { method: "DELETE" })
      queryClient.removeQueries({ queryKey: queryKeys.project(transport.serverUrl, id) })
      queryClient.setQueryData<readonly Project[]>(queryKeys.projects(transport.serverUrl), (current) => current?.filter((item) => item.id !== id))
      await workspaces.refresh()
    },
    reclone: async (id) => {
      await requireConfiguration()
      const project = oneProjectFromWire(await transport.json(`${projectPath(id)}/reclone`, { method: "POST" }))
      remember(project)
      await workspaces.refresh()
      return project
    },
  }
}

export function createProjectsApi(
  transport: Transport,
  queryClient: QueryClient,
  workspaces: Pick<Workspaces, "catalog" | "load" | "refresh" | "accountProjects">,
  createCloudWorkspace: CreateCloudWorkspace,
): ProjectsApi {
  const remember = projectCache(queryClient, transport.serverUrl)
  const hosted = async () => (await workspaces.load()).declaration.serverKind !== "daemon"
  const requireConfiguration = async () => {
    if (await hosted()) throw new ServerError({ class: "invalid", code: "project_configuration_unavailable", message: "Project configuration requires a daemon" })
  }
  const hostedCreate = hostedProjectCreator(workspaces, createCloudWorkspace)
  const daemonCreate = daemonProjectCreator(transport, workspaces)
  return {
    configurationAvailable: () => workspaces.catalog()?.declaration.serverKind === "daemon",
    create: async (input) => {
      const project = await ((await hosted()) ? hostedCreate(input) : daemonCreate(input))
      remember(project)
      return project
    },
    ...projectConfiguration(transport, queryClient, workspaces, remember, requireConfiguration),
  }
}
