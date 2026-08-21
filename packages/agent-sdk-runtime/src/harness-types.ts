export const AGENT_HARNESS_DEFINITIONS = [
  {
    key: "claude-acp",
    id: "claude",
    access: "acp",
    label: "Claude (ACP)",
    authEnv: "ANTHROPIC_API_KEY",
    authSlot: "anthropic",
  },
  {
    key: "codex-acp",
    id: "codex",
    access: "acp",
    label: "Codex (ACP)",
    authEnv: "OPENAI_API_KEY",
    authSlot: "openai",
  },
  {
    key: "cursor-acp",
    id: "cursor",
    access: "acp",
    label: "Cursor (ACP)",
    authEnv: "CURSOR_API_KEY",
    authSlot: "cursor",
  },
  {
    key: "claude",
    id: "claude",
    access: "native",
    label: "Claude",
    authEnv: "ANTHROPIC_API_KEY",
    authSlot: "anthropic",
  },
  {
    key: "codex",
    id: "codex",
    access: "native",
    label: "Codex",
    authEnv: "OPENAI_API_KEY",
    authSlot: "openai",
  },
  {
    key: "cursor",
    id: "cursor",
    access: "native",
    label: "Cursor",
    authEnv: "CURSOR_API_KEY",
    authSlot: "cursor",
  },
  {
    key: "opencode",
    id: "opencode",
    access: "native",
    label: "OpenCode",
    authEnv: "OPENAI_API_KEY",
    authSlot: "openai",
  },
  {
    key: "pi",
    id: "pi",
    access: "native",
    label: "Pi",
    authEnv: null,
    authSlot: null,
  },
] as const

export const AGENT_HARNESS_IDS = ["claude", "codex", "cursor", "opencode", "pi"] as const
export const AGENT_HARNESS_ACCESSES = ["acp", "native"] as const
export const AGENT_HARNESS_KEYS = AGENT_HARNESS_DEFINITIONS.map((item) => item.key)

export type AgentHarnessId = (typeof AGENT_HARNESS_IDS)[number]
export type AgentHarnessAccess = (typeof AGENT_HARNESS_ACCESSES)[number]
export type AgentHarnessKey = (typeof AGENT_HARNESS_KEYS)[number]
export type AcpHarnessId = Extract<AgentHarnessId, "claude" | "codex" | "cursor">
export type NativeHarnessId = AgentHarnessId
/**
 * A harness identity's id field: one of the finite built-in ids, or a
 * VALIDATED open ACP connection slug (`isAcpConnectionId`) for
 * `access: "acp"` identities. Native dispatch stays closed — an open slug is
 * only ever accepted alongside `access: "acp"` and only through the accepted
 * registry a host applies; it can never select a native adapter factory.
 * The `string & {}` half keeps literal narrowing on the built-in ids intact.
 */
export type SessionHarnessId = AgentHarnessId | (string & {})
export type AgentHarnessDefinition = (typeof AGENT_HARNESS_DEFINITIONS)[number]
export type AgentHarnessTransport = "stdio" | "streamable-http" | "websocket"
export type AgentHarnessTransportInput = AgentHarnessTransport | "http"

/**
 * Open ACP connection ids are stable lowercase slugs: they become the logical
 * harness identity (`acp:<id>`), directory-safe store keys, and query values.
 * The finite built-in ids all match this shape too, which keeps one grammar.
 */
export const ACP_CONNECTION_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

export function isAcpConnectionId(id: string): boolean {
  return ACP_CONNECTION_ID_PATTERN.test(id)
}

export function harnessDefinition(input: { id: string; access: string } | string): AgentHarnessDefinition | undefined {
  if (typeof input === "string") return AGENT_HARNESS_DEFINITIONS.find((item) => item.key === input)
  return AGENT_HARNESS_DEFINITIONS.find((item) => item.id === input.id && item.access === input.access)
}

export function isAgentHarnessId(id: string): id is AgentHarnessId {
  return (AGENT_HARNESS_IDS as readonly string[]).includes(id)
}

export function isAgentHarnessAccess(access: string): access is AgentHarnessAccess {
  return (AGENT_HARNESS_ACCESSES as readonly string[]).includes(access)
}

export function isAcpHarnessId(id: string): id is AcpHarnessId {
  return id === "claude" || id === "codex" || id === "cursor"
}

export function normalizeAgentHarnessTransport(input: unknown): AgentHarnessTransport | undefined {
  if (input === undefined) return
  if (input === "http" || input === "streamable-http") return "streamable-http"
  if (input === "stdio" || input === "websocket") return input
}

export function harnessKey(input: { id: SessionHarnessId; access: AgentHarnessAccess }) {
  const definition = harnessDefinition(input)
  if (definition) return definition.key
  // Open ACP connections have no definition row; their canonical
  // access-qualified presentation is `acp:<id>`.
  if (input.access === "acp" && isAcpConnectionId(input.id)) return `acp:${input.id}`
  return undefined
}

export function normalizeHarnessIdentity(input: unknown): { id: SessionHarnessId; access: AgentHarnessAccess } | undefined {
  if (typeof input === "string") {
    const legacy = legacyHarnessIdentity(input)
    if (legacy) return legacy
    if (isAgentHarnessId(input)) return { id: input, access: "native" }
    // Canonical open-ACP presentation: `acp:<slug>`. The bare-slug string form
    // stays native-only so an unqualified custom string can never be read as a
    // harness — ACP qualification must be explicit.
    if (input.startsWith("acp:")) {
      const slug = input.slice("acp:".length)
      if (isAcpConnectionId(slug)) return { id: slug, access: "acp" }
    }
    return undefined
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  const row = input as Record<string, unknown>
  const idInput = typeof row.id === "string" ? row.id : typeof row.type === "string" ? row.type : undefined
  const legacy = idInput ? legacyHarnessIdentity(idInput) : undefined
  const accessInput = typeof row.access === "string" ? row.access : undefined
  const id = legacy?.id
    ?? (idInput && isAgentHarnessId(idInput)
      ? idInput
      // A structured identity may carry an open ACP slug, but ONLY with an
      // explicit `access: "acp"` — an unknown id never defaults to native.
      : idInput && accessInput === "acp" && isAcpConnectionId(idInput)
        ? idInput
        : undefined)
  const access = legacy?.access ?? (accessInput && isAgentHarnessAccess(accessInput) ? accessInput : id ? "native" : undefined)
  if (!id || !access) return
  return { id, access }
}

function legacyHarnessIdentity(input: string): { id: AgentHarnessId; access: AgentHarnessAccess } | undefined {
  if (input === "claude-acp") return { id: "claude", access: "acp" }
  if (input === "codex-acp") return { id: "codex", access: "acp" }
  if (input === "cursor-acp") return { id: "cursor", access: "acp" }
  if (input === "claude-sdk") return { id: "claude", access: "native" }
  if (input === "codex-app-server") return { id: "codex", access: "native" }
  if (input === "cursor-sdk") return { id: "cursor", access: "native" }
  if (input === "opencode") return { id: "opencode", access: "native" }
  if (input === "pi") return { id: "pi", access: "native" }
}
