import type { ProviderDirect, ProviderProjection } from "@claxedo/agent-runtime-contract"

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
  pluginSelection?: { mode: "default" } | { mode: "selected"; selectionHash: string }
  generation: string
  mcpServers: readonly ProjectedMcpServer[]
  pluginRoots: readonly SkillRoot[]
  notApplied: readonly NotApplied[]
}

export type ResolvedCredentials = {
  accountOwner: string
  machineLoginAllowed: boolean
  providers: Readonly<Record<string, ProviderProjection>>
  direct?: Readonly<Record<string, ProviderDirect>>
  secrets: Readonly<Record<string, string>>
  leaseGeneration: string
}
