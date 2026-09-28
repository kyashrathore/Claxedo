import type { ConnectionConfigHooks } from "@claxedo/harness/providers"
import {
  connectionIdentityFingerprint,
  OPENCODE_SERVER_CONNECTION_CAPABILITIES,
  type OpenCodeServerConnectionConfig,
  validateOpenCodeServerConnectionConfig,
} from "./config"

export const OPENCODE_SERVER_CONNECTION_PROVIDER_KEY = "opencode-server"

export function createOpenCodeServerConnectionProvider(): ConnectionConfigHooks<OpenCodeServerConnectionConfig> {
  return {
    providerKey: OPENCODE_SERVER_CONNECTION_PROVIDER_KEY,
    validateConfig: validateOpenCodeServerConnectionConfig,
    immutableIdentity: connectionIdentityFingerprint,
    project(config) {
      return {
        label: config.label,
        readiness: "ready",
        capabilities: OPENCODE_SERVER_CONNECTION_CAPABILITIES,
        modelSelection: { status: "unsupported" },
      }
    },
  }
}
