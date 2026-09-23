import type { QueryClient } from "@tanstack/solid-query"
import { queryOptions } from "@tanstack/solid-query"
import { ServerError } from "./errors"
import { projectId as asProjectId, type ProjectId } from "./ids"
import { queryKeys } from "./query-keys"
import { jsonInit, type Transport } from "./transport"
import type { ProjectsApi } from "./index"
import type { Project, ProjectSource } from "./types"

const PROJECTS_PATH = "/api/claxedo/projects"

type WireProject = {
  readonly id: string
  readonly name: string
  readonly env?: Record<string, string>
  readonly directory?: string | null
  readonly repoUrl?: string | null
  readonly created_at: number
  readonly updated_at: number
}

function isWireProject(value: unknown): value is WireProject {
  const row = value as Partial<WireProject> | null
  return !!row && typeof row.id === "string" && typeof row.name === "string"
    && typeof row.created_at === "number" && typeof row.updated_at === "number"
}

function sourceOf(project: WireProject): ProjectSource | undefined {
  if (project.repoUrl) return { kind: "repository", url: project.repoUrl }
  if (project.directory) return { kind: "folder", path: project.directory }
  return undefined
}

export function projectFromWire(project: WireProject): Project {
  const source = sourceOf(project)
  return {
    id: asProjectId(project.id),
    name: project.name,
    ...(source ? { source } : {}),
    env: project.env ?? {},
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  }
}

function wireSource(source: ProjectSource) {
  switch (source.kind) {
    case "folder":
      return { kind: "directory", directory: source.path }
    case "repository":
      return { kind: "repository", repoUrl: source.url }
    case "connectedRepository":
      return { kind: "repository", connectionId: source.connectionId, repo: { fullName: source.fullName } }
  }
}

function oneProject(body: unknown): Project {
  const project = body && typeof body === "object" ? (body as { project?: unknown }).project : undefined
  if (!isWireProject(project)) throw new ServerError({ class: "internal", message: "The projects route answered without a project" })
  return projectFromWire(project)
}

export async function listProjects(transport: Transport): Promise<readonly Project[]> {
  const body = await transport.json<{ projects?: unknown }>(PROJECTS_PATH)
  const rows = Array.isArray(body.projects) ? body.projects : []
  return rows.filter(isWireProject).map(projectFromWire)
}

export function projectQueries(transport: Transport) {
  return {
    list: () => queryOptions({
      queryKey: queryKeys.projects(transport.serverUrl),
      queryFn: () => listProjects(transport),
    }),
    byId: (id: ProjectId) => queryOptions({
      queryKey: queryKeys.project(transport.serverUrl, id),
      queryFn: () => transport.json<unknown>(`${PROJECTS_PATH}/${encodeURIComponent(id)}`).then(oneProject),
    }),
  }
}

export function createProjectsApi(input: {
  readonly transport: Transport
  readonly queryClient: QueryClient
  readonly onChanged: () => Promise<void>
}): ProjectsApi {
  const { transport, queryClient } = input
  const remember = (project: Project) => {
    queryClient.setQueryData(queryKeys.project(transport.serverUrl, project.id), project)
    queryClient.setQueryData<readonly Project[]>(queryKeys.projects(transport.serverUrl), (current) => {
      const rest = (current ?? []).filter((item) => item.id !== project.id)
      return [...rest, project].sort((a, b) => a.createdAt - b.createdAt)
    })
  }
  return {
    create: async (options) => {
      const body = { source: wireSource(options.source), ...(options.name ? { name: options.name } : {}) }
      const project = oneProject(await transport.json<unknown>(PROJECTS_PATH, jsonInit("POST", body)))
      remember(project)
      await input.onChanged()
      return project
    },
    update: async (id, patch) => {
      const project = oneProject(await transport.json<unknown>(`${PROJECTS_PATH}/${encodeURIComponent(id)}`, jsonInit("PATCH", patch)))
      remember(project)
      return project
    },
    remove: async (id) => {
      await transport.json<unknown>(`${PROJECTS_PATH}/${encodeURIComponent(id)}`, { method: "DELETE" })
      queryClient.removeQueries({ queryKey: queryKeys.project(transport.serverUrl, id) })
      queryClient.setQueryData<readonly Project[]>(queryKeys.projects(transport.serverUrl), (current) => (current ?? []).filter((item) => item.id !== id))
      await input.onChanged()
    },
  }
}
