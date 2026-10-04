import type { CredentialSnapshot, SavedCommand } from "@claxedo/agent-runtime-contract"
import type { RuntimeSnapshot, RuntimeNativeHarnessId } from "@claxedo/workspace-runtime/config"
import type { AcpRuntimeMcpServer } from "../agent-plugins/runtime/mcp-projection"
import type { CustomProviderConfig } from "../credentials/custom-provider"
import { invalidSchema, type UserAgentConfig } from "./config"
import { snapshotDefaultHarness } from "./connections"

/** What Agent Plugins contributes to a runtime snapshot: a launch row per native harness and one for ACP connections, and the ACP MCP map. */
export type AgentPluginRuntimeContribution = {
  harnessLaunch: NonNullable<RuntimeSnapshot["harnessLaunch"]>
  mcp: Record<string, AcpRuntimeMcpServer>
}

export function composeRuntimeConfigSnapshot(input: {
  config: Pick<UserAgentConfig, "connections" | "defaultConnectionId" | "defaultHarness">
  provisionedRunner?: RuntimeNativeHarnessId
  providers: readonly CustomProviderConfig[]
  commands: SavedCommand[]
  auth: CredentialSnapshot
  plugins: AgentPluginRuntimeContribution
}): RuntimeSnapshot {
  const selected = snapshotDefaultHarness(input.config, input.provisionedRunner)
  if (selected?.kind === "connection" && !input.config.connections[selected.connectionId]?.enabled) {
    throw invalidSchema("selected connection is not installed and enabled")
  }
  return {
    version: 4,
    connections: Object.values(input.config.connections),
    ...(selected ? { defaultHarness: selected } : {}),
    auth: input.auth,
    commands: input.commands,
    ...input.plugins,
    providerDefinitions: input.providers.map((provider) => ({
      id: provider.providerID, name: provider.name, npm: "@ai-sdk/openai-compatible" as const,
      baseURL: provider.baseURL, headers: provider.headers, models: provider.models, credentialProviderId: provider.providerID,
      credentialSource: provider.env.length ? "machine-env" as const : "account" as const,
    })),
  }
}
