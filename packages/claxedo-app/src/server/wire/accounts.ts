import { isAccountScope, isAccountSource, type AccountScope, type AccountSource } from "@claxedo/account-contract/vocabulary"
import { piCredentialProviderIDs } from "@claxedo/agent-runtime-contract"
import { asFiniteNumber, asRecord, asString } from "@claxedo/helpers/guards"
import type { QuotaWindow } from "@claxedo/usage-contract"
import type { Account, AccountCheck, AccountDelivery, AccountSources, AccountVerdict, MachineLogin, MachineLoginState } from "../account-types"

function texts(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined
}

export function usageWindowsFromWire(value: unknown): readonly QuotaWindow[] | undefined {
  if (!Array.isArray(value)) return undefined
  const windows = value.flatMap((entry): QuotaWindow[] => {
    const row = asRecord(entry)
    const window = asString(row?.window)
    const usedPercent = asFiniteNumber(row?.usedPercent)
    if (window === undefined || usedPercent === undefined) return []
    return [{ window, usedPercent, resetsAt: asFiniteNumber(row?.resetsAt) ?? null }]
  })
  return windows.length > 0 ? windows : undefined
}

function deliveryFromWire(value: unknown): AccountDelivery | undefined {
  const row = asRecord(value)
  if (typeof row?.cloud !== "boolean") return undefined
  const reason = asString(row.reason)
  return { local: row.local !== false, cloud: row.cloud, ...(reason ? { reason } : {}) }
}

function definedFields<T extends object>(fields: T): Partial<T> {
  const defined: Partial<T> = {}
  for (const key in fields) if (fields[key] !== undefined) defined[key] = fields[key]
  return defined
}

export function accountScopeFromWire(value: unknown): AccountScope | undefined {
  return isAccountScope(value) ? value : undefined
}

export function accountFromWire(value: unknown): Account | undefined {
  const row = asRecord(value)
  const id = asString(row?.id)
  const providerId = asString(row?.provider_id)
  if (!row || !id || !providerId) return undefined
  const usage = usageWindowsFromWire(row.usage_windows)
  return {
    id,
    providerId,
    kind: asString(row.kind) ?? "unknown",
    source: asString(row.source) ?? "unknown",
    active: row.is_active === true,
    hasSecret: row.has_secret === true,
    ...definedFields({
      scope: accountScopeFromWire(row.scope),
      label: asString(row.label),
      accountId: asString(row.account_id),
      activatedAt: asFiniteNumber(row.activated_at),
      status: asString(row.status),
      health: asString(row.health),
      expiresAt: asFiniteNumber(row.expires_at),
      lastValidatedAt: asFiniteNumber(row.last_validated_at),
      usage,
      usageAt: usage ? asFiniteNumber(row.usage_at) : undefined,
      delivery: deliveryFromWire(row.deliverable),
    }),
  }
}

const LOGIN_STATES: readonly MachineLoginState[] = ["signed_in", "signed_out", "absent", "unknown"]

export function machineLoginFromWire(value: unknown): MachineLogin | undefined {
  const row = asRecord(value)
  const harness = asString(row?.harness)
  const providerIds = texts(row?.providerIds)
  const state = LOGIN_STATES.find((candidate) => candidate === row?.state)
  if (!row || harness === undefined || !providerIds || !state) return undefined
  const usage = usageWindowsFromWire(row.usage)
  return {
    harness,
    providerIds,
    state,
    ...definedFields({
      serves: texts(row.serves),
      email: asString(row.email),
      plan: asString(row.plan),
      org: asString(row.org),
      detail: asString(row.detail),
      usage,
      usageAt: usage ? asFiniteNumber(row.usageAt) : undefined,
    }),
  }
}

const VERDICTS: readonly AccountVerdict[] = ["ok", "auth_failed", "no_billing", "rate_capped", "expired", "unknown"]

export function accountCheckFromWire(value: unknown): AccountCheck | undefined {
  const row = asRecord(value)
  const verdict = VERDICTS.find((candidate) => candidate === row?.result)
  if (!row || !verdict) return undefined
  const usage = usageWindowsFromWire(row.usage)
  return { verdict, ...(usage ? { usage } : {}) }
}

export function rowsFromWire<T>(value: unknown, field: string, parse: (row: unknown) => T | undefined): T[] | undefined {
  const rows = asRecord(value)?.[field]
  if (!Array.isArray(rows)) return undefined
  return rows.flatMap((row) => {
    const parsed = parse(row)
    return parsed === undefined ? [] : [parsed]
  })
}

function sourcesFromWire(value: unknown): ReadonlyMap<string, AccountSource> | undefined {
  const row = asRecord(value)
  if (!row) return undefined
  const sources = new Map<string, AccountSource>()
  for (const [providerId, source] of Object.entries(row)) {
    if (!isAccountSource(source)) return undefined
    sources.set(providerId, source)
  }
  return sources
}

export function accountSourcesFromWire(value: unknown): AccountSources | undefined {
  const canRemoveOrgAccounts = asRecord(value)?.can_remove_org_accounts
  const sources = sourcesFromWire(asRecord(value)?.sources)
  const org = rowsFromWire(value, "org", accountFromWire)
  return sources && org && typeof canRemoveOrgAccounts === "boolean" ? { sources, org, canRemoveOrgAccounts } : undefined
}

export function piProviderAccountIds(providerId: string): readonly string[] {
  return piCredentialProviderIDs(providerId)
}
