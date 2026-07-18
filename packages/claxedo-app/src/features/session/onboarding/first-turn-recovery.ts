// Client-side mirror of the server classifier in
// packages/agent-sdk-runtime/src/first-turn-error.ts (classifyFirstTurnError).
// The server stamps error.data.firstTurnErrorClass on the wire and this module
// prefers it; the regexes below are only a fallback for errors that arrive
// class-less. Keep them in lockstep with that file — it is the source of truth.
// (agent-sdk-runtime cannot be imported here: it is not browser-safe.)
export type SessionErrorClass = "credential" | "harness" | "model" | "workspace" | "session" | "unknown"
export type FirstTurnMessage =
  | { id: string; role: "user"; time: { created: number } }
  | { id: string; role: "assistant"; parentID: string; time: { created: number; completed?: number }; error?: unknown }

// Copy is position-independent — descriptions must not reference "first turn".
// User-facing text says "agent", never "harness"/"ACP"/"adapter". Kept in sync
// with the §5 copy table in dev-docs/CLAXEDO_ERROR_PROPOSAL.md.
const recoveries = {
  credential: { kind: "credential", title: "Reconnect your AI provider", description: "The provider rejected the credential for this workspace.", label: "Reconnect provider" },
  harness: { kind: "harness", title: "The agent isn't responding", description: "The agent process stopped or couldn't run this turn.", label: "Try again" },
  model: { kind: "model", title: "Try another model", description: "The selected model couldn't serve this turn.", label: "Switch model and retry" },
  workspace: { kind: "workspace", title: "Workspace isn't ready", description: "The project workspace wasn't available for this turn.", label: "Retry" },
  session: { kind: "session", title: "This session was lost", description: "The agent process no longer has this conversation. Its history is still here.", label: "Start a new session" },
  unknown: { kind: "unknown", title: "That turn didn't complete", description: "Something went wrong and no more detail was reported.", label: "Try again" },
} as const satisfies Record<SessionErrorClass, { kind: SessionErrorClass; title: string; description: string; label: string }>

export function shouldShowStarterPrompts(input: { completedTurns: number; sentTurns: number }) {
  return input.completedTurns === 0 && input.sentTurns === 0
}

export function sessionRecovery(kind: SessionErrorClass) {
  return recoveries[kind]
}

export function sessionRecoveryClass(error: unknown): SessionErrorClass {
  const data = record(record(error)?.data)
  const classified = data?.firstTurnErrorClass
  if (
    classified === "credential" || classified === "harness" || classified === "model" ||
    classified === "workspace" || classified === "session" || classified === "unknown"
  ) return classified
  const message = typeof data?.message === "string" ? data.message : ""
  if (/\b(401|403|unauthori[sz]ed|api[ _-]?key|oauth|token|credential|authentication|billing|payment|quota|rate[ _-]?limit)\b/i.test(message)) return "credential"
  if (/(thread not found|session not found|conversation not found|no such (thread|session))/i.test(message)) return "session"
  if (/(harness|adapter|acp|agent process|spawn|executable|binary|capabilit(?:y|ies)|unsupported operation)/i.test(message)) return "harness"
  if (/(model|provider\/model|model id|deployment)/i.test(message)) return "model"
  if (/(workspace|worktree|repository|directory|sandbox|provision|filesystem|eacces|enoent|permission denied)/i.test(message)) return "workspace"
  return "unknown"
}

export function firstTurnOutcome(messages: FirstTurnMessage[]) {
  const first = messages.find((message): message is Extract<FirstTurnMessage, { role: "user" }> => message.role === "user")
  if (!first) return
  const assistant = messages.find((message): message is Extract<FirstTurnMessage, { role: "assistant" }> =>
    message.role === "assistant" && message.parentID === first.id,
  )
  if (!assistant || (typeof assistant.time.completed !== "number" && !assistant.error)) return
  if (!assistant.error) return { name: "first_turn_ok" as const }
  return { name: "first_turn_failed" as const, class: sessionRecoveryClass(assistant.error) }
}

export function firstTurnFunnelEvents(messages: FirstTurnMessage[], cloud: boolean) {
  const outcome = firstTurnOutcome(messages)
  if (!outcome) return []
  if (outcome.name !== "first_turn_ok" || !cloud) return [outcome]
  return [outcome, { name: "first_cloud_turn_ok" as const }]
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}
