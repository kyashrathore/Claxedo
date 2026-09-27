export type AgentPluginHarnessId = keyof typeof AGENT_PLUGIN_HARNESS_REGISTRY

export const CLAUDE_AGENT_ACP = "@agentclientprotocol/claude-agent-acp"

/**
 * What an installed plugin can honestly promise a harness, for the install
 * dialog to state per target. Every value is a fact about the harness's own
 * intake, not a Claxedo setting.
 */
export type AgentPluginHarnessDelivery = {
  /** Plugin MCP servers reach the harness. */
  mcpServers: true
  /**
   * Whole plugin roots (skills and MCP together) reach the harness. Over ACP
   * only `@agentclientprotocol/claude-agent-acp` takes them, through
   * `_meta.claudeCode.options.plugins`; every other ACP agent gets MCP servers
   * alone.
   */
  wholePlugins: { reach: "every-agent" } | { reach: "one-agent"; agent: string }
  /**
   * When a plugin installed while a session runs reaches that session:
   * the harness process is restarted after its active turn and the next
   * session start, load or resume carries the plugin. An ACP agent may be
   * restarted by that.
   */
  runningSession: { applies: "after-restart"; restartsAgent: boolean }
  cloud: {
    /** HTTP servers reach a sandbox through the plugin MCP gateway with a brokered secret. */
    httpServers: "plugin-mcp-gateway"
    /** Local commands run only when the sandbox image declares the command. */
    localCommands: "image-declared-only"
    /** A remote agent (a URL connection) gets no local commands and no local plugin paths. */
    remoteAgent: "no-local-commands-no-local-paths" | "not-applicable"
  }
  local: {
    /** The harness also reads its own global configuration, so installing does not isolate it. */
    readsOwnGlobalConfiguration: true
  }
}

type AgentPluginHarnessMetadata = {
  label: string
  projection: "standard-root" | "generated-view" | "session-request"
  /**
   * Whether the harness keeps each plugin's skills apart when several are
   * active. A `plugin` harness loads one directory per plugin, so two plugins
   * may each ship a skill called `review`. OpenCode's generated config takes a
   * flat list of skill directories, where the second `review` shadows the
   * first, so an explicit selection producing that pair is refused instead.
   */
  skillNamespace: "plugin" | "flat"
  delivery: AgentPluginHarnessDelivery
}

export type AgentPluginHarnessDescriptor = AgentPluginHarnessMetadata & { id: AgentPluginHarnessId }

const NATIVE_DELIVERY: AgentPluginHarnessDelivery = {
  mcpServers: true,
  wholePlugins: { reach: "every-agent" },
  runningSession: { applies: "after-restart", restartsAgent: false },
  cloud: { httpServers: "plugin-mcp-gateway", localCommands: "image-declared-only", remoteAgent: "not-applicable" },
  local: { readsOwnGlobalConfiguration: true },
}

export const AGENT_PLUGIN_HARNESS_REGISTRY = {
  opencode: { label: "OpenCode", projection: "generated-view", skillNamespace: "flat", delivery: NATIVE_DELIVERY },
  claude: { label: "Claude Code", projection: "generated-view", skillNamespace: "plugin", delivery: NATIVE_DELIVERY },
  codex: { label: "Codex", projection: "standard-root", skillNamespace: "plugin", delivery: NATIVE_DELIVERY },
  cursor: { label: "Cursor", projection: "standard-root", skillNamespace: "plugin", delivery: NATIVE_DELIVERY },
  acp: {
    label: "Custom ACP agents",
    projection: "session-request",
    skillNamespace: "plugin",
    delivery: {
      mcpServers: true,
      wholePlugins: { reach: "one-agent", agent: CLAUDE_AGENT_ACP },
      runningSession: { applies: "after-restart", restartsAgent: true },
      cloud: { httpServers: "plugin-mcp-gateway", localCommands: "image-declared-only", remoteAgent: "no-local-commands-no-local-paths" },
      local: { readsOwnGlobalConfiguration: true },
    },
  },
} satisfies Record<string, AgentPluginHarnessMetadata>

export const SUPPORTED_AGENT_PLUGIN_HARNESSES: readonly AgentPluginHarnessId[] = Object.keys(AGENT_PLUGIN_HARNESS_REGISTRY)
  .filter(isAgentPluginHarnessId)

export function agentPluginHarnessDescriptor(harnessId: AgentPluginHarnessId): AgentPluginHarnessDescriptor {
  return { id: harnessId, ...AGENT_PLUGIN_HARNESS_REGISTRY[harnessId] }
}

export function agentPluginHarnessTargets() {
  return SUPPORTED_AGENT_PLUGIN_HARNESSES.map((id) => {
    const { label, delivery } = AGENT_PLUGIN_HARNESS_REGISTRY[id]
    return { id, label, delivery }
  })
}

export function agentPluginHarnessRecord<T>(build: (harnessId: AgentPluginHarnessId) => T): Record<AgentPluginHarnessId, T> {
  const record = Object.fromEntries(SUPPORTED_AGENT_PLUGIN_HARNESSES.map((id) => [id, build(id)]))
  if (!isCompleteHarnessRecord(record)) throw new Error("Agent Plugins harness record is incomplete")
  return record
}

function isCompleteHarnessRecord<T>(record: Record<string, T>): record is Record<AgentPluginHarnessId, T> {
  return SUPPORTED_AGENT_PLUGIN_HARNESSES.every((id) => Object.hasOwn(record, id))
}

export function isAgentPluginHarnessId(value: unknown): value is AgentPluginHarnessId {
  return typeof value === "string"
    && Object.hasOwn(AGENT_PLUGIN_HARNESS_REGISTRY, value)
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
