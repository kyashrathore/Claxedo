import { api, getDefaultBaseUrl, normalizeUrl } from "@/platform/api/api"

/**
 * Projects on a server with its own filesystem (`/api/claxedo/projects`).
 *
 * A project is a repository and a name; where it executes is a workspace. The
 * server keeps a checkout of every project: the folder the caller pointed at,
 * or a repository it cloned under its data directory. Names are unique per
 * server.
 */
export type ProjectRecord = {
  id: string
  name: string
  env: Record<string, string>
  /** The project's checkout on this server: the folder it was created from, or its clone. */
  checkoutDirectory: string | null
  repoUrl: string | null
  created_at: number
  updated_at: number
}

export type ProjectSource = { kind: "directory"; folder: string } | { kind: "repository"; repoUrl: string }

function projectsUrl(baseUrl: string | undefined, path = "") {
  return `${normalizeUrl(baseUrl) ?? getDefaultBaseUrl()}/api/claxedo/projects${path}`
}

type WireProject = Omit<ProjectRecord, "checkoutDirectory"> & { directory: string | null }

function fromWire(project: WireProject): ProjectRecord {
  const { directory, ...rest } = project
  return { ...rest, checkoutDirectory: directory }
}

function toWireSource(source: ProjectSource) {
  return source.kind === "directory" ? { kind: "directory", directory: source.folder } : source
}

export async function createProject(input: {
  baseUrl?: string
  name: string
  source: ProjectSource
  env?: Record<string, string>
}) {
  const { project } = await api.post<{ project: WireProject }>(projectsUrl(input.baseUrl), {
    name: input.name,
    source: toWireSource(input.source),
    ...(input.env && Object.keys(input.env).length ? { env: input.env } : {}),
  })
  return fromWire(project)
}

export async function listProjectRecords(input: { baseUrl?: string } = {}) {
  const { projects } = await api.get<{ projects: WireProject[] }>(projectsUrl(input.baseUrl))
  return projects.map(fromWire)
}

/** The project behind a workspace's checkout (its worktree path on this server). */
export async function projectByCheckout(input: { baseUrl?: string; worktree: string }) {
  try {
    const { project } = await api.get<{ project: WireProject }>(
      projectsUrl(input.baseUrl, `/by-directory?directory=${encodeURIComponent(input.worktree)}`),
    )
    return fromWire(project)
  } catch {
    return undefined
  }
}

export async function updateProject(input: {
  baseUrl?: string
  id: string
  name?: string
  env?: Record<string, string>
}) {
  const { project } = await api.patch<{ project: WireProject }>(
    projectsUrl(input.baseUrl, `/${encodeURIComponent(input.id)}`),
    {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
    },
  )
  return fromWire(project)
}

/** The message the server gave for a refused create or update, or the error's own text. */
export function projectRequestMessage(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  const match = /"message":"([^"]+)"/.exec(text)
  return match?.[1] ?? text
}
