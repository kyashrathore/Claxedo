export const HARNESS_TARGETS = ["opencode", "claude", "codex", "cursor"] as const
export const FIRST_PARTY_AGENT_EXTENSION_ID = "first-party-agent-extensions"
export const FIRST_PARTY_AGENT_EXTENSIONS_DIR = "agent-extensions"
export const FIRST_PARTY_AGENT_EXTENSION_PACKAGE_NAME = "agent-extensions"
export type HarnessTarget = (typeof HARNESS_TARGETS)[number]

export type AgentExtensionScope = "project" | "workspace" | "machine"
export type MaterializedAgentExtensionScope = Exclude<AgentExtensionScope, "workspace">

export type PackageSource = {
  type: string
  owner?: string
  repo?: string
  ref?: string
  package_path?: string
}

export function isHarnessTarget(input: unknown): input is HarnessTarget {
  return HARNESS_TARGETS.includes(input as HarnessTarget)
}

export function allHarnessTargets(): HarnessTarget[] {
  return [...HARNESS_TARGETS]
}
