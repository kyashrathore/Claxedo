import type { ConnectionProvider } from "@claxedo/agent-sdk-runtime"
import { OpenCodeServerAdapter } from "./adapter"
import {
  connectionIdentityFingerprint,
  configuredSecretNames,
  OPENCODE_SERVER_CONNECTION_CAPABILITIES,
  resolveOpenCodeServerConnection,
  type OpenCodeServerConnectionConfig,
  type ResolvedOpenCodeServerConnection,
  validateOpenCodeServerConnectionConfig,
} from "./config"
import { OpenCodeServerAdapterError } from "./errors"

export const OPENCODE_SERVER_CONNECTION_PROVIDER_KEY = "opencode-server"

export function createOpenCodeServerConnectionProvider(): ConnectionProvider<OpenCodeServerConnectionConfig, ResolvedOpenCodeServerConnection> {
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
    resolve({ descriptor, directory, secrets }) {
      const configuredSecrets = configuredSecretNames(descriptor.config)
      const descriptorSecrets = Object.keys(descriptor.secretRefs ?? {}).sort()
      if (
        configuredSecrets.length !== descriptorSecrets.length
        || configuredSecrets.some((name, index) => name !== descriptorSecrets[index])
      ) {
        throw new OpenCodeServerAdapterError("invalid_config", "OpenCode descriptor secretRefs do not match configured secret names")
      }
      const config = resolveOpenCodeServerConnection({
        connectionId: descriptor.connectionId,
        config: descriptor.config,
        sourceDirectory: directory,
        secrets,
      })
      return { config }
    },
    createAdapter({ resolved }) {
      return new OpenCodeServerAdapter(resolved.config)
    },
  }
}
