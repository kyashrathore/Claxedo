export const SUPPORTED_AGENT_PLUGIN_HARNESSES = ["opencode", "claude", "codex", "cursor"] as const

export type AgentPluginHarnessId = (typeof SUPPORTED_AGENT_PLUGIN_HARNESSES)[number]

export type AgentPluginHarnessDescriptor = {
  id: AgentPluginHarnessId
  label: string
  projection: "standard-root" | "generated-view"
  /**
   * Whether the harness keeps each plugin's skills apart when several are
   * active. A `plugin` harness loads one directory per plugin, so two plugins
   * may each ship a skill called `review`. OpenCode's generated config takes a
   * flat list of skill directories, where the second `review` shadows the
   * first, so an explicit selection producing that pair is refused instead.
   */
  skillNamespace: "plugin" | "flat"
}

export const AGENT_PLUGIN_HARNESS_REGISTRY: readonly AgentPluginHarnessDescriptor[] = [
  { id: "opencode", label: "OpenCode", projection: "generated-view", skillNamespace: "flat" },
  { id: "claude", label: "Claude Code", projection: "generated-view", skillNamespace: "plugin" },
  { id: "codex", label: "Codex", projection: "standard-root", skillNamespace: "plugin" },
  { id: "cursor", label: "Cursor", projection: "standard-root", skillNamespace: "plugin" },
]

export function agentPluginHarnessDescriptor(harnessId: AgentPluginHarnessId): AgentPluginHarnessDescriptor {
  const descriptor = AGENT_PLUGIN_HARNESS_REGISTRY.find((candidate) => candidate.id === harnessId)
  if (!descriptor) throw new Error(`Unsupported Agent Plugins harness: ${harnessId}`)
  return descriptor
}

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
