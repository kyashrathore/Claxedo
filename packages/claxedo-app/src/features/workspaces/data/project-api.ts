import { api, getDefaultBaseUrl, normalizeUrl } from "@/platform/api/api"
import { readField, readString } from "@/lib/record"

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

/**
 * Where a project's repository comes from. A connection source names a
 * repository of the caller's connected code host; the server resolves the
 * clone URL and token itself, so a private clone never carries a token here.
 */
export type ProjectSource =
  | { kind: "directory"; folder: string }
  | { kind: "repository"; repoUrl: string }
  | { kind: "repository"; connectionId: string; repo: { fullName: string } }

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

/** The server names the project from its source (remote, folder or URL) and suffixes a clash. */
export async function createProject(input: {
  baseUrl?: string
  source: ProjectSource
  env?: Record<string, string>
}) {
  const { project } = await api.post<{ project: WireProject }>(projectsUrl(input.baseUrl), {
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

/** The `{ error: { code, message } }` envelope (or a bare `{ code, message }`) a refused project request carries in its thrown text. */
function projectRequestFailure(error: unknown): { text: string; code?: string; message?: string } {
  const text = error instanceof Error ? error.message : String(error)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { text }
  }
  const envelope = readField(body, "error")
  const code = readString(envelope, "code") ?? readString(body, "code")
  const message = readString(envelope, "message") ?? readString(body, "message")
  return { text, ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) }
}

/** The message the server gave for a refused create or update, or the error's own text. */
export function projectRequestMessage(error: unknown) {
  const failure = projectRequestFailure(error)
  return failure.message ?? failure.text
}

/** The server's code for a refused create or update, when it gave one. */
export function projectRequestCode(error: unknown) {
  return projectRequestFailure(error).code
}
