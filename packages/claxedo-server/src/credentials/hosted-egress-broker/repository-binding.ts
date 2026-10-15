import type { Binding } from "@claxedo/egress-broker"
import { githubCloneAuthorization } from "@claxedo/server-core/projects/repository-source"
import { githubRepositoryRoute, type HostedRepositoryClone } from "../../workspace/repository-clone"
import type { HostedBrokerClaims } from "./placeholder"

type HostedRepositoryCloneRead = (workspace: { workspaceId: string; ownerUserId: string; orgId: string }) => Promise<HostedRepositoryClone | undefined>

/** What a repository binding resolves to, installed on the broker by the composition that owns code-host connections. */
export type HostedRepositoryBindings = (bindingId: string, claims: HostedBrokerClaims) => Promise<{ binding: Binding; value: string } | undefined>

/**
 * The repository binding a placeholder names, read afresh on every request:
 * the workspace's private repository and the connection it was created
 * through, whose token is the connection's current one. A placeholder minted
 * for a connection the workspace no longer clones through resolves to nothing.
 */
export function hostedRepositoryBindings(read: HostedRepositoryCloneRead): HostedRepositoryBindings {
  return async (bindingId, claims) => {
    const clone = await read({ workspaceId: claims.workspaceId, ownerUserId: claims.userId, orgId: claims.orgId })
    if (!clone || clone.connectionId !== claims.credentialId) return undefined
    const route = githubRepositoryRoute(clone.repoUrl)
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
        status: "active",
        destination: { origin: route.origin, methods: route.methods, pathPrefixes: route.pathPrefixes },
        injection: { header: "Authorization" },
      },
      value: githubCloneAuthorization(clone.token),
    }
  }
}
