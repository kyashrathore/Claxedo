import { providerErrorDetail, providerUsageLimitDetail, type DispatchContext } from "./provider-error-detail"
import type { TimelineTextKey } from "./model"
import { asRecord } from "@claxedo/helpers/guards"
import { harnessDisplayLabel } from "@/lib/harness-catalog"
import {
  credentialBrokerErrorCode,
  CREDENTIAL_BROKER_ERRORS,
  FIRST_TURN_ERROR_CLASSES,
  turnAccount,
  type FirstTurnErrorClass,
} from "@claxedo/agent-runtime-contract"

export type SessionErrorClass = FirstTurnErrorClass

export type TurnRecoveryKeys = {
  readonly title: TimelineTextKey
  readonly description: TimelineTextKey
  readonly action?: TimelineTextKey
}

export function turnRecoveryKeys(kind: SessionErrorClass): TurnRecoveryKeys {
  const text = { title: `turnRecovery.${kind}.title`, description: `turnRecovery.${kind}.description` } as const
  return kind === "usage_limit" ? text : { ...text, action: `turnRecovery.${kind}.action` }
}

export function sessionRecoveryAccount(error: unknown): { readonly key: TimelineTextKey; readonly params: Record<string, string> } | undefined {
  const account = turnAccount(asRecord(asRecord(error)?.data)?.account)
  if (!account) return undefined
  const harness = harnessDisplayLabel(account.harnessId)
  if (account.kind === "machine") return { key: "turnRecovery.account.machine", params: { harness } }
  return { key: "turnRecovery.account.stored", params: { label: account.label ?? account.providerId, harness } }
}

export function sessionRecoveryTitle(kind: SessionErrorClass, error?: unknown, context?: DispatchContext) {
  return kind === "usage_limit" ? providerUsageLimitDetail(error, context)?.title : undefined
}

export function sessionRecoveryDescription(kind: SessionErrorClass, error?: unknown, context?: DispatchContext) {
  const { summary, status } = providerErrorDetail(error, context)
  if (status !== undefined && summary) return summary
  if (kind === "usage_limit") return providerUsageLimitDetail(error, context)?.description
  return kind === "unknown" ? summary : undefined
}

export function sessionRecoveryClass(error: unknown): SessionErrorClass {
  const data = asRecord(asRecord(error)?.data)
  const classified = FIRST_TURN_ERROR_CLASSES.find((kind) => kind === data?.firstTurnErrorClass)
  if (classified) return classified
  const message = typeof data?.message === "string" ? data.message : ""
  const broker = credentialBrokerErrorCode(message)
  if (broker) return CREDENTIAL_BROKER_ERRORS[broker].fault
  if (/(?:reached|hit)\s+(?:your|the)\s+.+?\s+limit|usage\s+(?:limit|cap)\s+(?:reached|exceeded)|limit.*(?:reset|usage credits)|usage_limit_reached|rate_limit_reached|credits_depleted|quota/i.test(message)) return "usage_limit"
  if (/\b429\b|\brate[ _-]?limit|too many requests|try again later/i.test(message)) return "rate_limit"
  if (/\b(401|403|unauthori[sz]ed|api[ _-]?key|oauth|token|credential|authentication|billing|payment)\b/i.test(message)) return "credential"
  if (/(thread not found|session not found|conversation not found|no such (thread|session))/i.test(message)) return "session"
  if (/(harness|adapter|acp|agent process|spawn|executable|binary|capabilit(?:y|ies)|unsupported operation)/i.test(message)) return "harness"
  if (/(model|provider\/model|model id|deployment)/i.test(message)) return "model"
  if (/(workspace|worktree|repository|directory|sandbox|provision|filesystem|eacces|enoent|permission denied)/i.test(message)) return "workspace"
  return "unknown"
}
