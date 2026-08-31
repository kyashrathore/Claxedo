export const AGENT_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" as const
export const AGENT_PLUGIN_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" as const

export type AgentPluginManifest = {
  $schema: typeof AGENT_PLUGIN_SCHEMA
  name: string
  version?: string
  description?: string
  author?: { name?: string; email?: string; url?: string }
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  extensions?: Record<string, Record<string, unknown>>
}

export type AgentPluginSkill = {
  name: string
  description: string
  path: string
}

export type AgentPluginStdioServer = {
  name: string
  type: "stdio"
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export type AgentPluginHttpServer = {
  name: string
  type: "streamable-http" | "sse"
  url: string
  headers?: Record<string, string>
}

export type AgentPluginMcpServer = AgentPluginStdioServer | AgentPluginHttpServer

export type ValidatedAgentPlugin = {
  root: string
  manifest: AgentPluginManifest
  skills: AgentPluginSkill[]
  mcp: {
    status: "absent" | "valid" | "invalid"
    servers: AgentPluginMcpServer[]
  }
}

export type AgentPluginDiagnosticCode =
  | "manifest_invalid"
  | "skills_invalid"
  | "skill_invalid"
  | "skill_path_escape"
  | "mcp_invalid"
  | "mcp_server_invalid"

export type AgentPluginDiagnostic = {
  code: AgentPluginDiagnosticCode
  path: string
  message: string
}

export type AgentPluginValidationResult =
  | { status: "invalid"; plugin?: undefined; diagnostics: AgentPluginDiagnostic[] }
  | { status: "valid"; plugin: ValidatedAgentPlugin; diagnostics: AgentPluginDiagnostic[] }

export type AgentPluginSourceKind = "claxedo" | "personal" | "organization"

export type AgentPluginCollectionSource = {
  id: string
  kind: AgentPluginSourceKind
  label: string
  revision: string
  /** Immediate children supplied by a filesystem, GitHub, or other product adapter. */
  plugins: readonly { relativePath: string; tree: AgentPluginTree }[]
  errors?: readonly {
    relativePath: string
    code: "manifest_invalid" | "plugin_root_escape" | "source_unavailable"
    message: string
  }[]
}

export type AgentPluginCatalogCandidate = {
  pluginInstanceId: string
  sourceId: string
  sourceKind: AgentPluginSourceKind
  sourceLabel: string
  sourceRevision: string
  relativePath: string
  artifactDigest: `sha256:${string}`
  manifest: AgentPluginManifest
  /** Validated component metadata only; source bytes remain acquisition-only. */
  mcp: ValidatedAgentPlugin["mcp"]
  componentDiagnostics: AgentPluginDiagnostic[]
  /** Acquisition input only. Runtime snapshots never expose source bytes. */
  tree: AgentPluginTree
}

export type AgentPluginCatalogError = {
  sourceId: string
  relativePath: string
  code: AgentPluginDiagnosticCode | "plugin_root_escape" | "source_unavailable"
  message: string
}

export type AgentPluginCollectionIndex = {
  source: Omit<AgentPluginCollectionSource, "plugins" | "errors">
  candidates: AgentPluginCatalogCandidate[]
  errors: AgentPluginCatalogError[]
}
import type { AgentPluginTree } from "../artifacts/tree"
