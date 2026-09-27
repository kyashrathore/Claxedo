import type { ProviderProjection } from "@claxedo/agent-runtime-contract"

export type McpServerSpec =
  | {
      kind: "stdio"
      name: string
      command: string
      args?: readonly string[]
      env?: Readonly<Record<string, string>>
      cwd?: string
    }
  | {
      kind: "http" | "sse"
      name: string
      url: string
      headers?: Readonly<Record<string, string>>
    }

export type McpOrigin = "first-party" | "configured" | "plugin"

export type ProjectedMcpServer = McpServerSpec & { origin: McpOrigin }

export type SkillRoot = {
  pluginInstanceId: string
  root: string
  dataRoot: string
  skillNames: readonly string[]
}

export type NotApplied = {
  item: string
  reason: "remote-harness" | "unsupported-by-harness" | "unsupported-transport" | "not-installed" | "not-consented"
}

export type PluginProjection = {
  generation: string
  mcpServers: readonly ProjectedMcpServer[]
  pluginRoots: readonly SkillRoot[]
  notApplied: readonly NotApplied[]
}

export type ResolvedCredentials = {
  providers: Readonly<Record<string, ProviderProjection>>
  secrets: Readonly<Record<string, string>>
  leaseGeneration: string
}
