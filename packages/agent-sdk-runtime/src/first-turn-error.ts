export const FIRST_TURN_ERROR_CLASSES = ["credential", "harness", "model", "usage_limit", "workspace", "session", "unknown"] as const

export type FirstTurnErrorClass = (typeof FIRST_TURN_ERROR_CLASSES)[number]

/**
 * The credential broker's own vocabulary, which a brokered harness echoes in
 * the message it reports.
 *
 * The status beside it cannot stand in for these: the broker answers 403 both
 * for a credential it will not serve and for a route the binding does not
 * allow, and reading that 403 as a credential failure tells the operator to
 * replace a working account for a request the harness should never have made.
 */
const BROKER_ERROR_CLASSES: Record<string, FirstTurnErrorClass> = {
  binding_unavailable: "credential",
  binding_not_permitted: "credential",
  credential_unavailable: "credential",
  runtime_token_invalid: "credential",
  runtime_token_required: "credential",
  binding_destination_invalid: "harness",
  binding_injection_invalid: "harness",
  binding_route_required: "harness",
  broker_authority_unavailable: "harness",
  request_outside_policy: "harness",
  upstream_redirect_refused: "model",
  upstream_unavailable: "model",
}

const brokerError = new RegExp(`\\b(${Object.keys(BROKER_ERROR_CLASSES).join("|")})\\b`)

const credential = /\b(401|403|unauthori[sz]ed|api[ _-]?key|oauth|token|credential|authentication|billing|payment|quota)\b/i
const usageLimit = /(?:reached|hit)\s+(?:your|the)\s+.+?\s+limit|usage\s+(?:limit|cap)\s+(?:reached|exceeded)|limit.*(?:reset|usage credits)|usage_limit_reached|rate_limit_reached|credits_depleted|\brate[ _-]?limit\b/i
const session = /(thread not found|session not found|conversation not found|no such (thread|session))/i
const harness = /(harness|adapter|acp|agent process|spawn|executable|binary|capabilit(?:y|ies)|unsupported operation)/i
const model = /(model|provider\/model|model id|deployment)/i
const workspace = /(workspace|worktree|repository|directory|sandbox|provision|filesystem|eacces|enoent|permission denied)/i

export function classifyFirstTurnError(error: unknown): FirstTurnErrorClass {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error)
  // First, because everything below it reads the status and the prose the
  // harness wrapped around this code.
  const broker = brokerError.exec(message)?.[1]
  if (broker) return BROKER_ERROR_CLASSES[broker]
  if (usageLimit.test(message)) return "usage_limit"
  if (credential.test(message)) return "credential"
  // Lost native conversations use session recovery, even when the message also names a harness.
  if (session.test(message)) return "session"
  if (harness.test(message)) return "harness"
  if (model.test(message)) return "model"
  if (workspace.test(message)) return "workspace"
  return "unknown"
}

export function firstTurnErrorData(message: string) {
  return {
    message,
    firstTurnErrorClass: classifyFirstTurnError(message),
  }
}
