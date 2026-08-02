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
export type AgentHarnessDefinition = (typeof AGENT_HARNESS_DEFINITIONS)[number]
export type AgentHarnessTransport = "stdio" | "streamable-http" | "websocket"
export type AgentHarnessTransportInput = AgentHarnessTransport | "http"

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

export function harnessKey(input: { id: AgentHarnessId; access: AgentHarnessAccess }) {
  return harnessDefinition(input)?.key
}

export function normalizeHarnessIdentity(input: unknown): { id: AgentHarnessId; access: AgentHarnessAccess } | undefined {
  if (typeof input === "string") {
    const legacy = legacyHarnessIdentity(input)
    if (legacy) return legacy
    return isAgentHarnessId(input) ? { id: input, access: "native" } : undefined
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  const row = input as Record<string, unknown>
  const idInput = typeof row.id === "string" ? row.id : typeof row.type === "string" ? row.type : undefined
  const legacy = idInput ? legacyHarnessIdentity(idInput) : undefined
  const id = legacy?.id ?? (idInput && isAgentHarnessId(idInput) ? idInput : undefined)
  const accessInput = typeof row.access === "string" ? row.access : undefined
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
