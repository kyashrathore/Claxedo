export const FIRST_TURN_ERROR_CLASSES = ["credential", "harness", "model", "usage_limit", "workspace", "session", "unknown"] as const

export type FirstTurnErrorClass = (typeof FIRST_TURN_ERROR_CLASSES)[number]

const credential = /\b(401|403|unauthori[sz]ed|api[ _-]?key|oauth|token|credential|authentication|billing|payment|quota|rate[ _-]?limit)\b/i
const usageLimit = /(?:reached|hit)\s+(?:your|the)\s+.+?\s+limit|usage\s+(?:limit|cap)\s+(?:reached|exceeded)|limit.*(?:reset|usage credits)/i
const session = /(thread not found|session not found|conversation not found|no such (thread|session))/i
const harness = /(harness|adapter|acp|agent process|spawn|executable|binary|capabilit(?:y|ies)|unsupported operation)/i
const model = /(model|provider\/model|model id|deployment)/i
const workspace = /(workspace|worktree|repository|directory|sandbox|provision|filesystem|eacces|enoent|permission denied)/i

export function classifyFirstTurnError(error: unknown): FirstTurnErrorClass {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error)
  if (usageLimit.test(message)) return "usage_limit"
  if (credential.test(message)) return "credential"
  // session is tested before harness: a lost thread must route to session recovery,
  // never be swallowed by the harness fallback (was previously mislabelled "workspace").
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
