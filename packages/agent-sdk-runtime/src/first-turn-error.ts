export const FIRST_TURN_ERROR_CLASSES = ["credential", "harness", "model", "workspace"] as const

export type FirstTurnErrorClass = (typeof FIRST_TURN_ERROR_CLASSES)[number]

const credential = /\b(401|403|unauthori[sz]ed|api[ _-]?key|oauth|token|credential|authentication|billing|payment|quota|rate[ _-]?limit)\b/i
const harness = /(harness|adapter|acp|agent process|spawn|executable|binary|capabilit(?:y|ies)|unsupported operation)/i
const model = /(model|provider\/model|model id|deployment)/i
const workspace = /(workspace|worktree|repository|directory|sandbox|provision|filesystem|eacces|enoent|permission denied)/i

export function classifyFirstTurnError(error: unknown): FirstTurnErrorClass {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error)
  if (credential.test(message)) return "credential"
  if (harness.test(message)) return "harness"
  if (model.test(message)) return "model"
  if (workspace.test(message)) return "workspace"
  return "workspace"
}

export function firstTurnErrorData(message: string) {
  return {
    message,
    firstTurnErrorClass: classifyFirstTurnError(message),
  }
}
