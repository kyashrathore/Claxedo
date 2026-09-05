import type { SandboxBrokeredSecret } from "@claxedo/sandbox-manager"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { RequestTiming } from "../request-timing"
import { encodePluginTreeBase64 } from "@claxedo/server-core/agent-plugins/artifacts/codec"
import type { AgentPluginArtifactStore } from "@claxedo/server-core/agent-plugins/artifacts/types"
import type { AgentPluginRuntimeApplyRequest } from "@claxedo/server-core/agent-plugins/runtime/apply-contract"
import type { WorkspaceRuntimePreparation } from "../../workspace/route-support"
import { agentPluginMcpRuntimePlan } from "../mcp/runtime-preparation"
import { desiredAgentPluginSelections, type SignedAgentPluginRuntimeSnapshot } from "./provision"

/**
 * The signed user's own runtime world, for a machine the user already owns.
 *
 * A cloud VM receives the same apply request through the hosted provisioner
 * and its brokered secrets through the sandbox driver. A signed desktop has
 * no broker between it and the user — the process that holds the gateway
 * credential IS the user's — so the credentials ride with the request, and
 * the desktop injects them into its own runtime exactly as the driver would.
 * `expiresAt` is the earliest credential expiry: the caller re-pulls before it
 * so a harness never holds a dead token.
 */
export type AgentPluginSelfRuntime = AgentPluginRuntimeApplyRequest & {
  secrets: SandboxBrokeredSecret[]
  expiresAt?: number
}

export type AgentPluginSelfRuntimeReader = (
  auth: SignedControlPlaneAuth,
  timing?: RequestTiming,
) => Promise<AgentPluginSelfRuntime>

export function createHostedAgentPluginSelfRuntime(input: {
  activations: { runtimeSnapshotForUser(auth: SignedControlPlaneAuth): Promise<SignedAgentPluginRuntimeSnapshot> }
  artifacts: AgentPluginArtifactStore
  preparer: {
    forSnapshot(
      snapshot: SignedAgentPluginRuntimeSnapshot,
      options?: { secretBrokering?: "native" },
    ): Promise<WorkspaceRuntimePreparation>
  }
  /** Gateway credential lifetime the preparer mints with; see `mintMcpGatewayToken`. */
  credentialTtlMs?: number
  now?: () => number
}): AgentPluginSelfRuntimeReader {
  const ttl = input.credentialTtlMs ?? 30 * 60_000
  const now = input.now ?? Date.now
  return async (auth, timing) => {
    const minted = now()
    const snapshot = await input.activations.runtimeSnapshotForUser(auth)
    timing?.mark("snapshot")
    const selections = desiredAgentPluginSelections(snapshot)
    const digests = [...new Set(selections.map((selection) => selection.artifactDigest))].toSorted()
    const artifacts = await Promise.all(digests.map(async (digest) => {
      const artifact = await input.artifacts.get(digest)
      if (!artifact) throw new Error(`Retained Agent Plugin artifact ${digest} is unavailable`)
      return { digest, tree: encodePluginTreeBase64(artifact.tree) }
    }))
    timing?.mark("artifacts")
    // The desktop is its own secret broker: the credentials travel in this
    // response and main hands them to the daemon, so the deployment's sandbox
    // posture (control-plane-only has no driver at all) must not decide
    // whether the user's own machine may reach the gateway.
    const preparation = await input.preparer.forSnapshot(snapshot, { secretBrokering: "native" })
    timing?.mark("preparation")
    const plan = agentPluginMcpRuntimePlan(preparation)
    const secrets = preparation.secrets ?? []
    return {
      version: 1,
      identity: { mode: "signed", userId: snapshot.identity.userId, projectId: snapshot.identity.projectId },
      revision: snapshot.revision,
      selections,
      artifacts,
      mcpServers: plan.mcpServers,
      secrets,
      ...(secrets.length ? { expiresAt: minted + ttl } : {}),
    }
  }
}
