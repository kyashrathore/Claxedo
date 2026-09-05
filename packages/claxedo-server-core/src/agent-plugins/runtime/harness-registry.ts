export const SUPPORTED_AGENT_PLUGIN_HARNESSES = ["opencode", "claude", "codex", "cursor"] as const

export type AgentPluginHarnessId = (typeof SUPPORTED_AGENT_PLUGIN_HARNESSES)[number]

export type AgentPluginHarnessDescriptor = {
  id: AgentPluginHarnessId
  label: string
  projection: "standard-root" | "generated-view"
}

export const AGENT_PLUGIN_HARNESS_REGISTRY: readonly AgentPluginHarnessDescriptor[] = [
  { id: "opencode", label: "OpenCode", projection: "generated-view" },
  { id: "claude", label: "Claude Code", projection: "generated-view" },
  { id: "codex", label: "Codex", projection: "standard-root" },
  { id: "cursor", label: "Cursor", projection: "standard-root" },
]

export function isAgentPluginHarnessId(value: unknown): value is AgentPluginHarnessId {
  return typeof value === "string"
    && SUPPORTED_AGENT_PLUGIN_HARNESSES.some((harnessId) => harnessId === value)
}

/**
 * Expands a UI convenience at the mutation boundary.
 *
 * The returned copy is intentional: persisted activation rows contain today's
 * explicit harness set, so adding another adapter later cannot silently opt a
 * user into it.
 */
export function allSupportedAgentPluginHarnesses(): AgentPluginHarnessId[] {
  return [...SUPPORTED_AGENT_PLUGIN_HARNESSES]
}
