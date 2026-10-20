import type { ContentfulStatusCode } from "hono/utils/http-status"
import { admittedRepoUrl, type RepoDestinationPolicy } from "@claxedo/sandbox-contract"
import type { SandboxDriver } from "@claxedo/sandbox-manager"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { isClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { contentfulStatus } from "../platform/http/status"
import { repositoryConnection, type GitHubRepositoryVisibility, type RepositoryConnectionRequest } from "./repository-connection"
import { apiError, type WorkspaceRouteOptions } from "./route-support"

export type CloudCreateSourceChecks = {
  admission: RepoDestinationPolicy
  connections?: WorkspaceRouteOptions["connections"]
  visibility: GitHubRepositoryVisibility
  orgDriver: () => Promise<SandboxDriver | undefined> | undefined
}

export type CloudCreateSource =
  | { ok: true; repoUrl: string; repoConnectionId?: string; placed: SandboxDriver | undefined }
  | { ok: false; status: ContentfulStatusCode; error: ReturnType<typeof apiError> }

const repoUrlInvalid = { ok: false, status: 400, error: apiError("repo_url_invalid", "That is not a repository URL this server can clone") } as const

function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason
  return result.value
}

/**
 * What a new cloud workspace's row is written with: the repository it clones,
 * admitted as a destination, the connection a private one is read through,
 * and the organization's sandbox driver. The pasted URL's admission, its
 * connection lookup and the driver read do not depend on each other, so they
 * run together and are judged in the order a refusal has always been
 * reported; nothing is written until all three have answered. A connection's
 * clone URL is admitted after its lookup, since it is that lookup's answer.
 */
export async function cloudCreateSource(auth: SignedControlPlaneAuth, request: RepositoryConnectionRequest, checks: CloudCreateSourceChecks): Promise<CloudCreateSource> {
  let repoUrl = request.repoUrl?.trim()
  const [pastedAdmission, connection, driver] = await Promise.allSettled([
    repoUrl ? admittedRepoUrl(repoUrl, checks.admission) : undefined,
    repositoryConnection(auth, { ...request, ...(repoUrl ? { repoUrl } : {}) }, {
      ...(checks.connections ? { connections: checks.connections } : {}),
      visibility: checks.visibility,
    }),
    (async () => checks.orgDriver())(),
  ])
  if (repoUrl && !settledValue(pastedAdmission)) return repoUrlInvalid
  let repoConnectionId: string | undefined
  const connected = settledValue(connection)
  if (connected && !connected.ok) return { ok: false, status: connected.status, error: apiError(connected.code, connected.message) }
  if (connected) {
    // A private repository is bound to the connection that reads it: every
    // boot's runtime preparation reads a fresh clone token through that
    // connection, which rides to the sandbox as a brokered secret, never in
    // the row or the clone URL.
    repoUrl = connected.repository.cloneUrl
    if (!(await admittedRepoUrl(repoUrl, checks.admission))) return repoUrlInvalid
    if (connected.repository.private) repoConnectionId = connected.connectionId
  }
  if (!repoUrl) return { ok: false, status: 400, error: apiError("cloud_workspace_source_required", "repoUrl is required for hosted cloud workspaces") }
  try {
    return { ok: true, repoUrl, ...(repoConnectionId ? { repoConnectionId } : {}), placed: settledValue(driver) }
  } catch (err) {
    if (!isClaxedoError(err)) throw err
    return { ok: false, status: contentfulStatus(err.status), error: apiError(err.code, err.message) }
  }
}
