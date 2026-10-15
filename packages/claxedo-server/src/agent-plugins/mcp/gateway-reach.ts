import type { SandboxSecretBrokering } from "@claxedo/sandbox-contract"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"

/** The harness a session's own Durable Object runs, which carries its gateway credentials itself. */
export const SESSION_HOST_HARNESS = "pi" satisfies AgentPluginHarnessId

/**
 * Only an explicit `"native"` capability may carry a minted gateway
 * credential: anything else refuses the server rather than hand the secret
 * to a runtime that cannot keep it unreadable.
 */
export function sandboxCarriesGatewayCredential(secretBrokering: SandboxSecretBrokering | undefined) {
  return secretBrokering === "native"
}
