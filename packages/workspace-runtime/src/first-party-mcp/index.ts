import type { RuntimeCredentialIssuer } from "./credential"

export {
  createRuntimeCredentialIssuer,
  runtimeCredentialWorkspaceId,
  type RuntimeCredentialClaims,
  type RuntimeCredentialIssuer,
  type RuntimeCredentialIssuerOptions,
  type RuntimeCredentialVerifier,
} from "./credential"

export const FIRST_PARTY_MCP_SERVER_NAME = "claxedo"
export const FIRST_PARTY_MCP_PATH = "/api/claxedo/mcp"

/**
 * The key both sides of the adapter config record agree on; agent-sdk-runtime
 * reads the provider from `applyConfig` under this exact name.
 */
export const FIRST_PARTY_MCP_CONFIG_KEY = "firstPartyMcp"

export type WorkspaceFirstPartyMcpLaunchOptions = {
  /** Loopback origin of the process that mounts {@link FIRST_PARTY_MCP_PATH}. */
  baseUrl: string
  issuer: RuntimeCredentialIssuer
  /**
   * The tool groups this project has turned on, which is also what the mount
   * will register. Empty means the built-in is off here, and then no session
   * gets an entry at all: an endpoint that would answer every call with "no
   * such tool" is not something to hand a harness.
   *
   * Read at each config apply and each launch rather than captured, so a
   * switch flipped in the Marketplace reaches the next session on a machine
   * whose runtime is already up.
   */
  enabledToolGroups: () => readonly string[]
}

export type FirstPartyMcpServerEntry = {
  name: string
  url: string
  headers: Record<string, string>
}

export function firstPartyMcpServerFor(
  options: WorkspaceFirstPartyMcpLaunchOptions,
  sessionId: string,
): FirstPartyMcpServerEntry | undefined {
  if (options.enabledToolGroups().length === 0) return undefined
  const url = new URL(FIRST_PARTY_MCP_PATH, options.baseUrl)
  url.searchParams.set("session", sessionId)
  return {
    name: FIRST_PARTY_MCP_SERVER_NAME,
    url: url.toString(),
    headers: { Authorization: options.issuer.header(sessionId) },
  }
}

/**
 * The provider spread into every adapter `applyConfig` call. The token is read
 * when a harness asks for a session's entry, not when config is applied, so a
 * refreshed or rotated credential reaches the next launch without a re-apply.
 */
export function firstPartyMcpAdapterConfig(options: WorkspaceFirstPartyMcpLaunchOptions | undefined) {
  if (!options || options.enabledToolGroups().length === 0) return {}
  return {
    [FIRST_PARTY_MCP_CONFIG_KEY]: {
      server: (sessionId: string) => firstPartyMcpServerFor(options, sessionId),
    },
  }
}
