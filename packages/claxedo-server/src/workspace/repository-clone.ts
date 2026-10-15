import type { SandboxSecretBrokering } from "@claxedo/sandbox-contract"
import type { SandboxBrokeredSecret } from "@claxedo/sandbox-manager"
import { githubCloneAuthorization } from "@claxedo/server-core/projects/repository-source"
import type { HostedEgressBroker } from "../credentials/hosted-egress-broker"
import type { WorkspaceRuntimePreparation } from "./route-support"

/** The private repository a cloud workspace clones, the connection it was created through, and that connection's token now. */
export type HostedRepositoryClone = Readonly<{ repoUrl: string; connectionId: string; token: string }>

const GITHUB_REPOSITORY_PATH = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/

/**
 * Where a GitHub clone credential may be spent: the one repository's
 * smart-HTTP routes (`info/refs`, `git-upload-pack`, `git-receive-pack`), so
 * the token cannot reach any other repository or GitHub API.
 */
export function githubRepositoryRoute(repositoryUrl: string) {
  const url = new URL(repositoryUrl)
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password
    || url.search || url.hash || !GITHUB_REPOSITORY_PATH.test(url.pathname)) {
    throw new Error("github_repository_url_required")
  }
  return { origin: url.origin, host: url.hostname, methods: ["GET", "POST"], pathPrefixes: [`${url.pathname}/`] }
}

/** The edge-swapped credential a driver with its own provider edge clones and fetches one GitHub repository with. */
export function githubCloneSecret(repositoryUrl: string, token: string): SandboxBrokeredSecret {
  const route = githubRepositoryRoute(repositoryUrl)
  return {
    name: "CLAXEDO_GITHUB_CLONE_AUTH",
    value: githubCloneAuthorization(token),
    hosts: [route.host],
    header: "Authorization",
    methods: route.methods,
    pathPrefixes: route.pathPrefixes,
  }
}

/**
 * The boot env of a sandbox with no provider edge: its git reaches the
 * repository through the plane's broker at `baseUrl`, presenting the
 * placeholder, and the broker attaches the connection's current token.
 */
export function githubCloneBrokerEnv(binding: { baseUrl: string; placeholder: string }): Record<string, string> {
  return {
    CLAXEDO_GITHUB_CLONE_AUTH: `Bearer ${binding.placeholder}`,
    CLAXEDO_GITHUB_CLONE_BROKER_URL: binding.baseUrl,
  }
}

type CloudWorkspace = { workspaceId: string; ownerUserId: string; orgId: string }

/**
 * How a cloud workspace's sandbox is given its private repository. A driver
 * with its own provider edge gets the connection's token as an edge secret.
 * One without gets a placeholder of the plane's broker, minted for the lease
 * it boots, and the broker attaches the connection's token to each git
 * request, so no token enters that sandbox; without a broker it gets nothing
 * and the clone fails in git.
 */
export function hostedRepositoryCloneDelivery(input: {
  clone: (workspace: CloudWorkspace) => Promise<HostedRepositoryClone | undefined>
  secretBrokering: (workspaceId: string) => Promise<SandboxSecretBrokering>
  broker?: Pick<HostedEgressBroker, "repositoryBinding">
}) {
  return async (workspace: CloudWorkspace): Promise<Required<Pick<WorkspaceRuntimePreparation, "secrets">> & Pick<WorkspaceRuntimePreparation, "leaseEnv">> => {
    if (await input.secretBrokering(workspace.workspaceId) === "native") {
      const clone = await input.clone(workspace)
      return { secrets: clone ? [githubCloneSecret(clone.repoUrl, clone.token)] : [] }
    }
    const broker = input.broker
    if (!broker) return { secrets: [] }
    return {
      secrets: [],
      leaseEnv: async (lease) => {
        const clone = await input.clone(workspace)
        if (!clone) return {}
        return githubCloneBrokerEnv(await broker.repositoryBinding({ ...workspace, connectionId: clone.connectionId, lease }))
      },
    }
  }
}
