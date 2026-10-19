import type { McpServiceGrant, McpToolGroup } from "@claxedo/mcp/tool-group"

/** The owner grant a cloud root was launched with, which a plugin's renewal can replace in place. */
export type RuntimeHostOwnerGrant = Readonly<{ swap(token: string): void }>

/**
 * What a first-party plugin hands a cloud root's workspace runtime. The
 * runtime starts each plugin it was composed with once, at boot, from the
 * environment the control plane launched it with.
 */
export type RuntimeHostPlugin = Readonly<{
  id: string
  mcp?: Readonly<{ groups: readonly McpToolGroup[] }>
  /** Nothing when the launch environment granted this plugin nothing. */
  start(env: NodeJS.ProcessEnv, input: Readonly<{ ownerGrant?: RuntimeHostOwnerGrant }>): RuntimeHostPluginInstance | undefined
}>

export type RuntimeHostPluginInstance = Readonly<{
  /** Read for each new MCP session, because a grant can lapse while the runtime runs. */
  mcpServices(): Readonly<Record<string, McpServiceGrant>>
  dispose(): void
}>
