import { providerErrorDetail, providerUsageLimitDetail, type DispatchContext } from "./provider-error-detail"
import type { TimelineTextKey } from "./model"
import { asRecord } from "@claxedo/helpers/guards"
import { harnessDisplayLabel } from "@/lib/harness-catalog"
import {
  classifyFirstTurnError,
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
  return classifyFirstTurnError(typeof data?.message === "string" ? data.message : "")
}
