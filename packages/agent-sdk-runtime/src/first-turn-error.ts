import { credentialBrokerErrorCode, CREDENTIAL_BROKER_ERRORS } from "@claxedo/agent-runtime-contract"

export const FIRST_TURN_ERROR_CLASSES = ["credential", "harness", "model", "usage_limit", "workspace", "session", "unknown"] as const

export type FirstTurnErrorClass = (typeof FIRST_TURN_ERROR_CLASSES)[number]

/**
 * The broker's verdict, out of the vocabulary the broker itself writes.
 *
 * Imported rather than restated: a code this file forgot used to fall through
 * to the prose rules below, which read the 403 the broker answers both for a
 * credential it will not serve and for a route the binding does not allow — and
 * told the operator to replace a working account for a request the harness
 * should never have made.
 */
function brokerFault(message: string): FirstTurnErrorClass | undefined {
  const code = credentialBrokerErrorCode(message)
  return code ? CREDENTIAL_BROKER_ERRORS[code].fault : undefined
}

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
  const broker = brokerFault(message)
  if (broker) return broker
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
