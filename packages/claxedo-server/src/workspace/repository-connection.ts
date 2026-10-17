import { withDeadlineSignal } from "@claxedo/helpers/deadline"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { RepositoryConnectionAccess, WorkspaceRouteOptions } from "./route-support"

type RepositoryConnections = NonNullable<WorkspaceRouteOptions["connections"]>
type ConnectedRepository = Extract<RepositoryConnectionAccess, { ok: true }>

/** Whether anyone may clone a GitHub repository, as an anonymous `git clone` would find. */
export type GitHubRepositoryVisibility = (fullName: string) => Promise<"public" | "unreadable">

export type RepositoryConnectionRefusal = {
  ok: false
  status: Extract<RepositoryConnectionAccess, { ok: false }>["status"]
  code: string
  message: string
}

export type RepositoryConnectionRequest = {
  connectionId?: string
  repo?: { fullName: string }
  repoUrl?: string
}

const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/
const VISIBILITY_DEADLINE_MS = 10_000

function githubPath(repoUrl: string) {
  const scp = /^git@github\.com:(.+)$/i.exec(repoUrl)
  if (scp) return scp[1]
  try {
    const url = new URL(repoUrl)
    if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "ssh:") return undefined
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined
    if (url.port || url.password || url.search || url.hash || (url.username && url.protocol !== "ssh:")) return undefined
    return url.pathname
  } catch {
    return undefined
  }
}

/** The `owner/repo` a pasted URL names on github.com, in its https, ssh or scp-style form. */
export function githubRepositoryFullName(repoUrl: string) {
  const segments = githubPath(repoUrl.trim())?.replace(/\/+$/, "").replace(/\.git$/i, "").split("/").filter(Boolean)
  if (segments?.length !== 2) return undefined
  if (!segments.every((segment) => GITHUB_NAME.test(segment) && segment !== "." && segment !== "..")) return undefined
  return segments.join("/")
}

/**
 * GitHub's smart-HTTP ref advertisement, asked with no credential: 200 for a
 * public repository, 401 for a private or missing one. The REST API would
 * answer the same, but anonymously it allows 60 requests an hour per egress
 * address, which every Worker isolate shares.
 */
export function anonymousGitHubVisibility(fetcher: (url: string, init?: RequestInit) => Promise<Response>): GitHubRepositoryVisibility {
  return (fullName) => withDeadlineSignal(VISIBILITY_DEADLINE_MS, async (signal) => {
    const response = await fetcher(`https://github.com/${fullName}.git/info/refs?service=git-upload-pack`, {
      headers: { "user-agent": "claxedo" },
      signal,
    })
    await response.body?.cancel()
    if (response.ok) return "public"
    if (response.status === 401 || response.status === 403 || response.status === 404) return "unreadable"
    throw new Error(`GitHub answered ${response.status}`)
  })
}

function pastedRefusal(fullName: string, access: Extract<RepositoryConnectionAccess, { ok: false }>): RepositoryConnectionRefusal {
  const repository = `github.com/${fullName}`
  if (access.code === "connection_not_found") {
    return {
      ok: false,
      status: 403,
      code: "repository_connection_required",
      message: `${repository} is private or does not exist. Connect GitHub with access to it in Connections, or use a public repository.`,
    }
  }
  if (access.status >= 500) {
    return {
      ok: false,
      status: 502,
      code: access.code,
      message: `Your GitHub connection could not list its repositories, so ${repository} could not be checked. Try again, or reconnect GitHub in Connections.`,
    }
  }
  return {
    ok: false,
    status: 403,
    code: "repository_access_required",
    message: `The GitHub App can't read ${repository}; give it access in GitHub, then try again.`,
  }
}

async function pastedRepositoryConnection(
  auth: SignedControlPlaneAuth,
  repoUrl: string,
  connections: RepositoryConnections,
  visibility: GitHubRepositoryVisibility,
): Promise<ConnectedRepository | RepositoryConnectionRefusal | undefined> {
  const fullName = githubRepositoryFullName(repoUrl)
  if (!fullName) return undefined
  const access = await connections.repositoryForAuth(auth, undefined, fullName)
  if (access.ok) return access
  const visible = await visibility(fullName).catch(() => undefined)
  if (visible === "public") return undefined
  if (!visible) {
    return {
      ok: false,
      status: 502,
      code: "repository_visibility_unavailable",
      message: `GitHub could not be reached to check whether github.com/${fullName} is public. Try again.`,
    }
  }
  return pastedRefusal(fullName, access)
}

/**
 * The connection a new cloud workspace's repository is read through: the one
 * the caller picked with the repository, or for a pasted GitHub URL the
 * caller's connection that can read it. Undefined when there is none to use
 * and the URL clones as it is: another host, a repository anyone may clone,
 * or a deployment with no connections host. A pasted private repository no
 * connection can read is refused here rather than failing its first clone.
 */
export async function repositoryConnection(
  auth: SignedControlPlaneAuth,
  request: RepositoryConnectionRequest,
  options: { connections?: RepositoryConnections; visibility: GitHubRepositoryVisibility },
): Promise<ConnectedRepository | RepositoryConnectionRefusal | undefined> {
  if (request.connectionId && request.repo) {
    if (!options.connections) {
      return { ok: false, status: 501, code: "repository_connections_unavailable", message: "Repository connections are unavailable" }
    }
    const access = await options.connections.repositoryForAuth(auth, request.connectionId, request.repo.fullName)
    return access.ok ? access : { ...access, message: "Repository connection is not available" }
  }
  if (!request.repoUrl || !options.connections) return undefined
  return pastedRepositoryConnection(auth, request.repoUrl, options.connections, options.visibility)
}
