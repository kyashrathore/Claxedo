import { asRecord } from "./values"

export const AGENT_HARNESS_DEFINITIONS = [
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
    key: "pi",
    id: "pi",
    access: "native",
    label: "Pi",
    authEnv: null,
    authSlot: null,
  },
  {
    // The public embedded OpenCode SDK, composed by `@claxedo/workspace-runtime/opencode`.
    // Credentials reach it through Claxedo's credential bridge, not an auth slot.
    key: "opencode",
    id: "opencode",
    access: "native",
    label: "OpenCode",
    authEnv: null,
    authSlot: null,
  },
] as const

export const AGENT_HARNESS_IDS = ["claude", "codex", "cursor", "pi", "opencode"] as const
export const AGENT_HARNESS_ACCESSES = ["connection", "native"] as const
export const AGENT_HARNESS_KEYS = AGENT_HARNESS_DEFINITIONS.map((item) => item.key)

export type AgentHarnessId = (typeof AGENT_HARNESS_IDS)[number]
export type AgentHarnessAccess = (typeof AGENT_HARNESS_ACCESSES)[number]
export type AgentHarnessKey = (typeof AGENT_HARNESS_KEYS)[number]
export type NativeHarnessId = AgentHarnessId
/** The native harnesses driven through `SdkRuntimeDriver`; `opencode` is composed by `@claxedo/workspace-runtime/opencode` instead. */
export type NativeSdkHarnessId = Extract<AgentHarnessId, "claude" | "codex" | "cursor" | "pi">
/**
 * A harness identity's id field: one of the finite built-in ids, or a
 * validated configured connection id for `access: "connection"` identities.
 * Native dispatch stays closed — an open id is only ever accepted alongside
 * `access: "connection"` and only through the accepted
 * registry a host applies; it can never select a native adapter factory.
 * The `string & {}` half keeps literal narrowing on the built-in ids intact.
 */
export type SessionHarnessId = AgentHarnessId | (string & {})
export type AgentHarnessDefinition = (typeof AGENT_HARNESS_DEFINITIONS)[number]
export type AgentHarnessTransport = "stdio" | "streamable-http" | "websocket"

/**
 * Open ACP connection ids are stable lowercase slugs: they become
 * directory-safe store keys and query values.
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

export function normalizeAgentHarnessTransport(input: unknown): AgentHarnessTransport | undefined {
  if (input === undefined) return undefined
  if (input === "stdio" || input === "streamable-http" || input === "websocket") return input
  return undefined
}

export function harnessKey(input: { id: SessionHarnessId; access: AgentHarnessAccess }) {
  const definition = harnessDefinition(input)
  if (definition) return definition.key
  if (input.access === "connection" && isAcpConnectionId(input.id)) return `connection:${input.id}`
  return undefined
}

export function normalizeHarnessIdentity(input: unknown): { id: SessionHarnessId; access: AgentHarnessAccess } | undefined {
  if (typeof input === "string") {
    if (isAgentHarnessId(input)) return { id: input, access: "native" }
    return undefined
  }
  const row = asRecord(input)
  if (!row) return undefined
  const idInput = typeof row.id === "string" ? row.id : undefined
  const accessInput = typeof row.access === "string" ? row.access : undefined
  const id = idInput && isAgentHarnessId(idInput)
      ? idInput
      : idInput && accessInput === "connection" && isAcpConnectionId(idInput)
        ? idInput
        : undefined
  const access = accessInput && isAgentHarnessAccess(accessInput) ? accessInput : id ? "native" : undefined
  if (!id || !access) return undefined
  return { id, access }
}

/** A session's harness identity: a built-in id, or a configured connection id. */
export type SessionHarness = {
  id: SessionHarnessId
  access: AgentHarnessAccess
}
