// Client-side mirror of the server classifier in
// packages/agent-sdk-runtime/src/first-turn-error.ts (classifyFirstTurnError).
// The server stamps error.data.firstTurnErrorClass on the wire and this module
// prefers it; the regexes below are only a fallback for errors that arrive
// class-less. Keep them in lockstep with that file — it is the source of truth.
// (agent-sdk-runtime cannot be imported here: it is not browser-safe.)
import { providerErrorDetail } from "./provider-error-detail"

export type SessionErrorClass = "credential" | "harness" | "model" | "workspace" | "session" | "unknown"
export type FirstTurnMessage =
  | { id: string; role: "user"; time: { created: number } }
  | { id: string; role: "assistant"; parentID: string; time: { created: number; completed?: number }; error?: unknown }

// Copy is position-independent — descriptions must not reference "first turn".
// User-facing text says "agent", never "harness"/"ACP"/"adapter". Kept in sync
// with the §5 copy table in dev-docs/CLAXEDO_ERROR_PROPOSAL.md.
const recoveries = {
  credential: {
    kind: "credential",
    title: "Reconnect your AI provider",
    description: "The provider rejected the credential for this workspace.",
    label: "Reconnect and resend",
  },
  harness: {
    kind: "harness",
    title: "The agent isn't responding",
    description: "The agent process stopped or couldn't run this turn.",
    label: "Resend last prompt",
  },
  model: {
    kind: "model",
    title: "Try another model",
    description: "The selected model couldn't serve this turn.",
    label: "Switch model and resend",
  },
  workspace: {
    kind: "workspace",
    title: "Workspace isn't ready",
    description: "The project workspace wasn't available for this turn.",
    label: "Resend last prompt",
  },
  session: {
    kind: "session",
    title: "This session was lost",
    description: "The agent process no longer has this conversation. Its history is still here.",
    label: "Start a new session",
  },
  // No generic-shrug copy: the description is always derived from the wire
  // error by sessionRecoveryDescription(). This sentence is the last-resort
  // failure wording for an error object that named nothing at all, and it
  // still says what we know rather than shrugging.
  unknown: {
    kind: "unknown",
    title: "That turn didn't complete",
    description: "The agent returned an error before completing this turn. Resend the last prompt.",
    label: "Resend last prompt",
  },
} as const satisfies Record<
  SessionErrorClass,
  { kind: SessionErrorClass; title: string; description: string; label: string }
>

export function sessionRecovery(kind: SessionErrorClass) {
  return recoveries[kind]
}

/**
 * The description to render for a failed turn. Never a generic shrug: it names
 * what failed, why, and what to do.
 *
 * The provider's own sentence wins whenever the wire error carried a real HTTP
 * status, for EVERY class — a 401 classifies as `credential`, and the class
 * copy ("The provider rejected the credential for this workspace.") is strictly
 * vaguer than "Anthropic rejected the credential (401). Check your API key in
 * Settings…". Without a status there is nothing more specific to say, so the
 * class keeps its own repair sentence; `unknown` alone falls through to the
 * error-derived wording, since its class copy would otherwise say nothing at all.
 */
export function sessionRecoveryDescription(
  kind: SessionErrorClass,
  error?: unknown,
  context?: { providerID?: string; modelID?: string },
) {
  const fallback = recoveries[kind].description
  const { summary, status } = providerErrorDetail(error, context)
  if (status !== undefined && summary) return summary
  if (kind !== "unknown") return fallback
  return summary ?? fallback
}

export function sessionRecoveryClass(error: unknown): SessionErrorClass {
  const data = record(record(error)?.data)
  const classified = data?.firstTurnErrorClass
  if (
    classified === "credential" ||
    classified === "harness" ||
    classified === "model" ||
    classified === "workspace" ||
    classified === "session" ||
    classified === "unknown"
  )
    return classified
  const message = typeof data?.message === "string" ? data.message : ""
  if (
    /\b(401|403|unauthori[sz]ed|api[ _-]?key|oauth|token|credential|authentication|billing|payment|quota|rate[ _-]?limit)\b/i.test(
      message,
    )
  )
    return "credential"
  if (/(thread not found|session not found|conversation not found|no such (thread|session))/i.test(message))
    return "session"
  if (
    /(harness|adapter|acp|agent process|spawn|executable|binary|capabilit(?:y|ies)|unsupported operation)/i.test(
      message,
    )
  )
    return "harness"
  if (/(model|provider\/model|model id|deployment)/i.test(message)) return "model"
  if (
    /(workspace|worktree|repository|directory|sandbox|provision|filesystem|eacces|enoent|permission denied)/i.test(
      message,
    )
  )
    return "workspace"
  return "unknown"
}

export function firstTurnOutcome(messages: FirstTurnMessage[]) {
  const first = messages.find(
    (message): message is Extract<FirstTurnMessage, { role: "user" }> => message.role === "user",
  )
  if (!first) return
  const assistant = messages.find(
    (message): message is Extract<FirstTurnMessage, { role: "assistant" }> =>
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
