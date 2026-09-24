import type { QuotaWindow } from "@claxedo/usage-contract"
import type { Account, AccountCheck, AccountDelivery, AccountVerdict, MachineLogin, MachineLoginState } from "../account-types"

type Row = Record<string, unknown>

function record(value: unknown): Row | undefined {
  return value && typeof value === "object" ? (value as Row) : undefined
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function texts(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined
}

export function usageWindowsFromWire(value: unknown): readonly QuotaWindow[] | undefined {
  if (!Array.isArray(value)) return undefined
  const windows = value.flatMap((entry): QuotaWindow[] => {
    const row = record(entry)
    const window = text(row?.window)
    const usedPercent = finite(row?.usedPercent)
    if (window === undefined || usedPercent === undefined) return []
    return [{ window, usedPercent, resetsAt: finite(row?.resetsAt) ?? null }]
  })
  return windows.length > 0 ? windows : undefined
}

function deliveryFromWire(value: unknown): AccountDelivery | undefined {
  const row = record(value)
  if (typeof row?.cloud !== "boolean") return undefined
  const reason = text(row.reason)
  return { local: row.local !== false, cloud: row.cloud, ...(reason ? { reason } : {}) }
}

function present<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>
}

export function accountFromWire(value: unknown): Account | undefined {
  const row = record(value)
  const id = text(row?.id)
  const providerId = text(row?.provider_id)
  if (!row || !id || !providerId) return undefined
  const usage = usageWindowsFromWire(row.usage_windows)
  return {
    id,
    providerId,
    kind: text(row.kind) ?? "unknown",
    source: text(row.source) ?? "unknown",
    active: row.is_active === true,
    hasSecret: row.has_secret === true,
    scope: text(row.scope) ?? "local",
    ...present({
      label: text(row.label),
      accountId: text(row.account_id),
      status: text(row.status),
      health: text(row.health),
      expiresAt: finite(row.expires_at),
      lastValidatedAt: finite(row.last_validated_at),
      usage,
      usageAt: usage ? finite(row.usage_at) : undefined,
      delivery: deliveryFromWire(row.deliverable),
    }),
  }
}

const LOGIN_STATES: readonly MachineLoginState[] = ["signed_in", "signed_out", "absent", "unknown"]

export function machineLoginFromWire(value: unknown): MachineLogin | undefined {
  const row = record(value)
  const harness = text(row?.harness)
  const providerIds = texts(row?.providerIds)
  const state = LOGIN_STATES.find((candidate) => candidate === row?.state)
  if (!row || harness === undefined || !providerIds || !state) return undefined
  const usage = usageWindowsFromWire(row.usage)
  return {
    harness,
    providerIds,
    state,
    ...present({
      serves: texts(row.serves),
      email: text(row.email),
      plan: text(row.plan),
      org: text(row.org),
      detail: text(row.detail),
      usage,
      usageAt: usage ? finite(row.usageAt) : undefined,
    }),
  }
}

const VERDICTS: readonly AccountVerdict[] = ["ok", "auth_failed", "no_billing", "rate_capped", "expired", "unknown"]

export function accountCheckFromWire(value: unknown): AccountCheck | undefined {
  const row = record(value)
  const verdict = VERDICTS.find((candidate) => candidate === row?.result)
  if (!row || !verdict) return undefined
  const usage = usageWindowsFromWire(row.usage)
  return { verdict, ...(usage ? { usage } : {}) }
}

export function rowsFromWire<T>(value: unknown, field: string, parse: (row: unknown) => T | undefined): T[] | undefined {
  const rows = record(value)?.[field]
  if (!Array.isArray(rows)) return undefined
  return rows.flatMap((row) => {
    const parsed = parse(row)
    return parsed === undefined ? [] : [parsed]
  })
}
