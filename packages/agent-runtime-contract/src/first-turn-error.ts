import { credentialBrokerErrorCode, CREDENTIAL_BROKER_ERRORS } from "./credential-broker-errors"
import type { FirstTurnErrorClass } from "./turn-error-classes"
import type { TurnAccount } from "./turn-account"

/**
 * The broker's verdict, out of the vocabulary the broker itself writes.
 *
 * Imported rather than restated: the broker answers 403 both for a credential
 * it will not serve and for a route the binding does not allow, and only its
 * own table separates those two faults. The prose rules below match on message
 * text, which cannot.
 */
function brokerFault(message: string): FirstTurnErrorClass | undefined {
  const code = credentialBrokerErrorCode(message)
  return code ? CREDENTIAL_BROKER_ERRORS[code].fault : undefined
}

const credential = /\b(401|403|unauthori[sz]ed|api[ _-]?key|oauth|token|credential|authentication|billing|payment)\b/i
const usageLimit = /(?:reached|hit)\s+(?:your|the)\s+.+?\s+limit|usage\s+(?:limit|cap)\s+(?:reached|exceeded)|limit.*(?:reset|usage credits)|usage_limit_reached|rate_limit_reached|credits_depleted|quota/i
const rateLimit = /\b429\b|\brate[ _-]?limit|too many requests|try again later/i
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
  if (rateLimit.test(message)) return "rate_limit"
  if (credential.test(message)) return "credential"
  // Lost native conversations use session recovery, even when the message also names a harness.
  if (session.test(message)) return "session"
  if (harness.test(message)) return "harness"
  if (model.test(message)) return "model"
  if (workspace.test(message)) return "workspace"
  return "unknown"
}

/** `errorClass` is the transport's structured class; the message is read only without one. */
export function firstTurnErrorData(message: string, facts: { errorClass?: FirstTurnErrorClass; account?: TurnAccount } = {}) {
  return {
    message,
    firstTurnErrorClass: facts.errorClass ?? classifyFirstTurnError(message),
    ...(facts.account ? { account: facts.account } : {}),
  }
}
