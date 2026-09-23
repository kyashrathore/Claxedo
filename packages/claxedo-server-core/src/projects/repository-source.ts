import type { GitHttpCredential } from "@claxedo/workspace-runtime/host"
import { admittedRepoUrl, repoUrlHost, safeRepoUrl, type RepoAddressResolver } from "@claxedo/sandbox-contract"
import type { SignedControlPlaneAuth } from "../platform/auth/auth"
import { ProjectStoreError, trimmedProjectName, type ProjectErrorStatus, type ProjectSource, type RepositoryResolution } from "./store"

/**
 * The shape a deployment's connections host answers with. The failure
 * statuses are the ones that host can return, so a refusal is relayed with
 * its own status.
 */
export type RepositoryAccessResult =
  | { ok: true; repository: { cloneUrl: string }; token: string }
  | { ok: false; status: Exclude<ProjectErrorStatus, 400>; code: string }

export type RepositorySourceDeps = {
  /**
   * The repository `fullName` (`owner/repo`) as the signed caller's connection
   * sees it, and the token that clones it. `connectionId` is the connection
   * the caller chose; `undefined` asks for the connected account they hold for
   * the repository's host, which is how a pasted GitHub URL still clones a
   * private repository. Deployments with a connections host supply it.
   */
  repositoryForAuth?: (
    auth: SignedControlPlaneAuth,
    connectionId: string | undefined,
    fullName: string,
  ) => Promise<RepositoryAccessResult>
  /**
   * Destination admission for a signed caller's URL: a remote caller drives
   * this deployment's network, so a clone must not become a reachability
   * oracle into its own addresses. `resolve` answers DNS the way the cloning
   * host will dial it (`node:dns` on a server, DNS-over-HTTPS in a Worker);
   * `privateHosts` are the operator's explicitly approved non-public Git
   * servers. The unsigned local product's operator keeps loopback and LAN
   * repositories, which are ordinary clone sources on one's own machine.
   */
  admission?: { resolve: RepoAddressResolver; privateHosts?: readonly string[] }
}

export type RepositorySource = Extract<ProjectSource, { kind: "repository" }>

/** GitHub's token-in-basic-auth form for `x-access-token`, as the cloud clone path uses. */
export function githubCloneAuthorization(token: string) {
  return `Basic ${btoa(`x-access-token:${token}`)}`
}

/** The `owner/repo` a clone URL names: its last two path segments, `.git` stripped. */
function repositoryFullName(repoUrl: string) {
  const repoPath = (() => {
    try {
      return new URL(repoUrl).pathname
    } catch {
      return repoUrl.slice(repoUrl.indexOf(":") + 1)
    }
  })()
  const segments = repoPath.replace(/\.git$/, "").split("/").filter(Boolean)
  return segments.length >= 2 ? segments.slice(-2).join("/") : undefined
}

export function lastPathSegment(value: string) {
  return value.replace(/\/+$/, "").split("/").pop() ?? ""
}

function invalid() {
  return new ProjectStoreError(400, "project_repository_invalid", "That is not a repository URL this server can clone")
}

async function admitted(repoUrl: string, caller: SignedControlPlaneAuth | undefined, deps: RepositorySourceDeps) {
  if (!caller) return
  if (!deps.admission) {
    throw new ProjectStoreError(503, "repository_admission_unavailable", "Repository destination admission is not configured for signed callers")
  }
  const ok = await admittedRepoUrl(repoUrl, {
    resolve: deps.admission.resolve,
    ...(deps.admission.privateHosts ? { privateHosts: deps.admission.privateHosts } : {}),
  })
  if (!ok) throw new ProjectStoreError(400, "project_repository_refused", "That repository is not a destination this server may clone")
}

/**
 * The URL this server will record and clone, the name the project takes when
 * the caller sent none, and the credential the clone carries. A signed
 * caller's URL is admitted before anything else reads it.
 */
export async function resolveRepository(
  source: RepositorySource,
  caller: SignedControlPlaneAuth | undefined,
  deps: RepositorySourceDeps,
): Promise<RepositoryResolution> {
  if ("repoUrl" in source) {
    const repoUrl = safeRepoUrl(source.repoUrl)
    if (!repoUrl) throw invalid()
    await admitted(repoUrl, caller, deps)
    const name = trimmedProjectName(lastPathSegment(repoUrl).replace(/\.git$/, ""))
    if (!name) throw invalid()
    const credential = await connectedCredential(repoUrl, caller, deps)
    return { repoUrl, name, ...(credential ? { credential } : {}) }
  }

  if (!caller) {
    throw new ProjectStoreError(400, "project_connection_requires_signin", "Cloning through a connected account needs a signed-in deployment")
  }
  if (!deps.repositoryForAuth) {
    throw new ProjectStoreError(501, "repository_connections_unavailable", "Repository connections are unavailable")
  }
  const access = await repositoryAccess(deps.repositoryForAuth, caller, source.connectionId, source.repo.fullName)
  if (!access.ok) throw new ProjectStoreError(access.status, access.code, access.message)
  const repoUrl = safeRepoUrl(access.repository.cloneUrl)
  const host = repoUrl && repoUrlHost(repoUrl)
  if (!repoUrl || !host) throw invalid()
  await admitted(repoUrl, caller, deps)
  const name = trimmedProjectName(lastPathSegment(source.repo.fullName))
  if (!name) throw invalid()
  return { repoUrl, name, credential: { host, authorization: githubCloneAuthorization(access.token) } }
}

type RepositoryAccess =
  | Extract<RepositoryAccessResult, { ok: true }>
  | { ok: false; status: ProjectErrorStatus; code: string; message: string }

/** A resolver that throws is a connections host this server could not reach, not a refusal it answered. */
async function repositoryAccess(
  resolve: NonNullable<RepositorySourceDeps["repositoryForAuth"]>,
  auth: SignedControlPlaneAuth,
  connectionId: string | undefined,
  fullName: string,
): Promise<RepositoryAccess> {
  try {
    const access = await resolve(auth, connectionId, fullName)
    return access.ok ? access : { ...access, message: "Repository connection is not available" }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, status: 502, code: "project_repository_unavailable", message: `Repository connection failed: ${message}` }
  }
}

/**
 * The credential for a URL the signed caller pasted: the token of the account
 * they connected for that host, when the connection proves they can read the
 * repository. A connection that answers no — none connected, the repository
 * not among theirs, read denied — clones anonymously, as a public repository
 * needs; a connections host that failed is reported instead. The token only
 * ever travels to the host the connection answered with: a name that happens
 * to exist on GitHub must not send a GitHub token to some other server.
 */
async function connectedCredential(
  repoUrl: string,
  caller: SignedControlPlaneAuth | undefined,
  deps: RepositorySourceDeps,
): Promise<GitHttpCredential | undefined> {
  const fullName = repositoryFullName(repoUrl)
  const host = repoUrlHost(repoUrl)
  if (!caller || !deps.repositoryForAuth || !fullName || !host) return undefined
  const access = await repositoryAccess(deps.repositoryForAuth, caller, undefined, fullName)
  if (!access.ok) {
    if (access.status >= 500) throw new ProjectStoreError(access.status, access.code, access.message)
    return undefined
  }
  if (repoUrlHost(access.repository.cloneUrl) !== host) return undefined
  return { host, authorization: githubCloneAuthorization(access.token) }
}
