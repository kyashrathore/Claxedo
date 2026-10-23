import type { Binding } from "@claxedo/egress-broker"
import { githubCloneAuthorization } from "@claxedo/server-core/projects/repository-source"
import { githubRepositoryRoute, type HostedRepositoryClone } from "../../workspace/repository-clone"
import type { HostedBrokerClaims } from "./placeholder"

type HostedRepositoryCloneRead = (workspace: { workspaceId: string; ownerUserId: string; orgId: string }) => Promise<HostedRepositoryClone | undefined>

/** The current token of a code-host connection its owner still holds in the organization; nothing once they no longer do. */
export type HostedConnectionToken = (owner: { ownerUserId: string; orgId: string }, connectionId: string) => Promise<string | undefined>

/** What a repository binding resolves to, installed on the broker by the composition that owns code-host connections. */
export type HostedRepositoryBindings = (bindingId: string, claims: HostedBrokerClaims) => Promise<{ binding: Binding; value: string } | undefined>

function repositoryBinding(bindingId: string, claims: HostedBrokerClaims, clone: HostedRepositoryClone, destination: Binding["destination"]) {
  return {
    binding: {
      userId: claims.userId,
      orgId: claims.orgId,
      workspaceId: claims.workspaceId,
      leaseId: claims.leaseId,
      leaseGeneration: claims.leaseGeneration,
      runtimeId: claims.runtimeId,
      id: bindingId,
      credentialId: clone.connectionId,
      revision: 1,
      status: "active" as const,
      destination,
      injection: { header: "Authorization" },
    },
    value: githubCloneAuthorization(clone.token),
  }
}

/** A clone fetches and nothing more: the ref advertisement and the pack, never a push. */
function cloneOnly(repoUrl: string): Binding["destination"] {
  const route = githubRepositoryRoute(repoUrl)
  const repository = new URL(repoUrl).pathname
  return { origin: route.origin, methods: route.methods, pathPrefixes: [], exactPaths: [`${repository}/info/refs`, `${repository}/git-upload-pack`] }
}

/**
 * The repository binding a placeholder names, read afresh on every request:
 * the workspace's private repository and the connection it was created
 * through, whose token is the connection's current one. A placeholder minted
 * for a connection the workspace no longer clones through resolves to nothing.
 * A connected machine's clone stand-in names its repository and connection
 * itself, and resolves to that connection's current token for the clone's
 * fetches alone.
 */
export function hostedRepositoryBindings(read: HostedRepositoryCloneRead, connectionToken?: HostedConnectionToken): HostedRepositoryBindings {
  return async (bindingId, claims) => {
    if (claims.repository !== undefined) {
      if (claims.enrollmentId === undefined || !connectionToken) return undefined
      const token = await connectionToken({ ownerUserId: claims.userId, orgId: claims.orgId }, claims.credentialId)
      const repoUrl = `https://github.com/${claims.repository.fullName}.git`
      return token === undefined ? undefined : repositoryBinding(bindingId, claims, { repoUrl, connectionId: claims.credentialId, token }, cloneOnly(repoUrl))
    }
    if (claims.workspaceId === undefined) return undefined
    const clone = await read({ workspaceId: claims.workspaceId, ownerUserId: claims.userId, orgId: claims.orgId })
    if (!clone || clone.connectionId !== claims.credentialId) return undefined
    const route = githubRepositoryRoute(clone.repoUrl)
    return repositoryBinding(bindingId, claims, clone, { origin: route.origin, methods: route.methods, pathPrefixes: route.pathPrefixes })
  }
}
