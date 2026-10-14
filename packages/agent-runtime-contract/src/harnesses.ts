import { asRecord } from "./values"

/**
 * Where a harness's session runs on a cloud workspace. A `session-host`
 * harness runs in the session's own Durable Object, which holds the owner's
 * credential itself; a `workspace-runtime` harness runs inside the sandbox,
 * which never holds a secret and reaches the vendor through a placeholder.
 * The control plane places a session by this when it reserves it, and the
 * sandbox runtime refuses to host a `session-host` harness, so neither side
 * can run a harness where its credential cannot follow.
 */
export type CloudHarnessHost = "session-host" | "workspace-runtime"

export const AGENT_HARNESS_DEFINITIONS = [
  {
    key: "claude",
    id: "claude",
    access: "native",
    label: "Claude",
    authEnv: "ANTHROPIC_API_KEY",
    authSlot: "anthropic",
    cloudHost: "workspace-runtime",
  },
  {
    key: "codex",
    id: "codex",
    access: "native",
    label: "Codex",
    authEnv: "OPENAI_API_KEY",
    authSlot: "openai",
    cloudHost: "workspace-runtime",
  },
  {
    key: "cursor",
    id: "cursor",
    access: "native",
    label: "Cursor",
    authEnv: "CURSOR_API_KEY",
    authSlot: "cursor",
    cloudHost: "workspace-runtime",
  },
  {
    key: "pi",
    id: "pi",
    access: "native",
    label: "Pi",
    authEnv: null,
    authSlot: null,
    cloudHost: "session-host",
  },
  {
    // The public embedded OpenCode SDK, composed by `@claxedo/harness/opencode-sdk`.
    // Credentials reach it through Claxedo's credential bridge, not an auth slot.
    key: "opencode",
    id: "opencode",
    access: "native",
    label: "OpenCode",
    authEnv: null,
    authSlot: null,
    cloudHost: "workspace-runtime",
  },
] as const

/** A connection's agent runs inside the sandbox, as does any harness the table does not name. */
export function cloudHarnessHost(harnessId: string): CloudHarnessHost {
  return AGENT_HARNESS_DEFINITIONS.find((item) => item.id === harnessId)?.cloudHost ?? "workspace-runtime"
}

export const AGENT_HARNESS_IDS = ["claude", "codex", "cursor", "pi", "opencode"] as const
export const AGENT_HARNESS_ACCESSES = ["connection", "native"] as const
export const AGENT_HARNESS_KEYS = AGENT_HARNESS_DEFINITIONS.map((item) => item.key)

export type AgentHarnessId = (typeof AGENT_HARNESS_IDS)[number]
export type AgentHarnessAccess = (typeof AGENT_HARNESS_ACCESSES)[number]
export type AgentHarnessKey = (typeof AGENT_HARNESS_KEYS)[number]
export type NativeHarnessId = AgentHarnessId
/** The native harnesses driven through `SdkRuntimeDriver`; `opencode` is composed by `@claxedo/harness/opencode-sdk` instead. */
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

export function sameSessionHarness(a: SessionHarness, b: SessionHarness) {
  return a.id === b.id && a.access === b.access
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

/**
 * How a harness takes a session's standing instruction block, and when.
 *
 * `turn-system-prompt` — a real system prompt, composed into every turn.
 * `thread-start` — a real system prompt given once when the harness thread is
 *   created; the thread holds it, so repeating it per turn would send it twice.
 * `prompt-prefix` — no separate slot: the block rides at the head of the same
 *   prompt the user's own text is in, on every turn.
 * `none` — no channel; a session created with a block is refused rather than
 *   running under instructions the harness never received.
 */
export const HARNESS_INSTRUCTION_CHANNELS = [
  "turn-system-prompt",
  "thread-start",
  "prompt-prefix",
  "none",
] as const

export type HarnessInstructionChannel = (typeof HARNESS_INSTRUCTION_CHANNELS)[number]
