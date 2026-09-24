import { queryOptions } from "@tanstack/solid-query"
import type { QuotaWindow } from "@claxedo/usage-contract"
import type { AppError, ErrorClass } from "@/server"
import { readArray, readBoolean, readField, readFiniteNumber, readString } from "@/lib/record"
import type { AccountDelivery, AccountsSnapshot, MachineLogin, ProviderVerdict, StoredAccount } from "./accounts"
import { isVerdict } from "./accounts"

const CREDENTIALS = "/api/claxedo/credentials"

const errorClass = (status: number): ErrorClass => {
  if (status === 401 || status === 403) return "auth"
  if (status === 404 || status === 501) return "not_found"
  if (status === 409) return "conflict"
  if (status === 429) return "rate_limit"
  return status >= 400 && status < 500 ? "invalid" : "internal"
}

async function request(path: string, init?: RequestInit & { accept?: readonly number[] }): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set("accept", "application/json")
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json")
  const response = await fetch(path, { credentials: "include", ...init, headers })
  if (response.ok || init?.accept?.includes(response.status)) return response
  const body: unknown = await response.json().catch(() => undefined)
  const failure = readField(body, "error")
  const message =
    readString(readField(readField(failure, "details"), "detail"), "message")
    ?? readString(failure, "message")
    ?? readString(body, "message")
    ?? `Request failed (${response.status})`
  throw { class: errorClass(response.status), message, retryable: response.status >= 500, status: response.status } satisfies AppError
}

export function readUsageWindows(value: unknown): QuotaWindow[] | undefined {
  if (!Array.isArray(value)) return undefined
  const windows = value.flatMap((entry): QuotaWindow[] => {
    const window = readString(entry, "window")
    const usedPercent = readFiniteNumber(entry, "usedPercent")
    if (window === undefined || usedPercent === undefined) return []
    return [{ window, usedPercent, resetsAt: readFiniteNumber(entry, "resetsAt") ?? null }]
  })
  return windows.length > 0 ? windows : undefined
}

function readDelivery(row: unknown): AccountDelivery | undefined {
  const field = readField(row, "deliverable")
  const cloud = readBoolean(field, "cloud")
  if (cloud === undefined) return undefined
  const reason = readString(field, "reason")
  return { local: readBoolean(field, "local") ?? true, cloud, ...(reason === undefined ? {} : { reason }) }
}

function storedAccount(row: unknown): StoredAccount | undefined {
  const id = readString(row, "id")
  const providerId = readString(row, "provider_id")
  if (id === undefined || providerId === undefined) return undefined
  const usage = readUsageWindows(readField(row, "usage_windows"))
  const optional = {
    label: readString(row, "label"),
    kind: readString(row, "kind"),
    accountId: readString(row, "account_id"),
    health: readString(row, "health"),
    lastValidatedAt: readFiniteNumber(row, "last_validated_at"),
    usageAt: usage === undefined ? undefined : readFiniteNumber(row, "usage_at"),
    delivery: readDelivery(row),
    expiresAt: readFiniteNumber(row, "expires_at"),
  }
  const present = Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined))
  return { id, providerId, isActive: readBoolean(row, "is_active") === true, ...(usage ? { usage } : {}), ...present }
}

function machineLogin(row: unknown): MachineLogin | undefined {
  const harness = readString(row, "harness")
  const state = readString(row, "state")
  const providerIds = readArray(row, "providerIds")?.filter((id): id is string => typeof id === "string")
  if (harness === undefined || !providerIds) return undefined
  if (state !== "signed_in" && state !== "signed_out" && state !== "absent" && state !== "unknown") return undefined
  const usage = readUsageWindows(readField(row, "usage"))
  const optional = {
    serves: readArray(row, "serves")?.filter((id): id is string => typeof id === "string"),
    email: readString(row, "email"),
    plan: readString(row, "plan"),
    org: readString(row, "org"),
    detail: readString(row, "detail"),
    usageAt: usage ? readFiniteNumber(row, "usageAt") : undefined,
  }
  const present = Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined))
  return { harness, providerIds, state, ...(usage ? { usage } : {}), ...present }
}

async function listStored(): Promise<StoredAccount[]> {
  const rows = readArray(await (await request(CREDENTIALS)).json(), "credentials") ?? []
  return rows.flatMap((row) => {
    const account = storedAccount(row)
    return account ? [account] : []
  })
}

async function listEffective(): Promise<ReadonlyMap<string, StoredAccount> | undefined> {
  const response = await request(`${CREDENTIALS}/effective`, { accept: [501] })
  if (response.status === 501) return undefined
  const rows = readArray(await response.json(), "credentials") ?? []
  const effective = new Map<string, StoredAccount>()
  for (const row of rows) {
    const account = storedAccount(row)
    if (account) effective.set(account.providerId, account)
  }
  return effective
}

export async function loadMachineLogins(input: { harness?: string; fresh?: boolean } = {}): Promise<MachineLogin[]> {
  const query = new URLSearchParams()
  if (input.harness !== undefined) query.set("harness", input.harness)
  if (input.fresh) query.set("fresh", "1")
  const search = query.size > 0 ? `?${query}` : ""
  const response = await request(`${CREDENTIALS}/machine-logins${search}`, { accept: [501] })
  if (response.status === 501) return []
  const rows = readArray(await response.json(), "machine_logins")
  if (!rows) throw { class: "internal", message: "The machine login read returned an invalid response", retryable: false } satisfies AppError
  return rows.flatMap((row) => {
    const login = machineLogin(row)
    return login ? [login] : []
  })
}

export async function scanAccounts(): Promise<AccountsSnapshot> {
  const [machineLogins, stored, effective] = await Promise.all([loadMachineLogins(), listStored(), listEffective()])
  return { stored, effective, machineLogins, scannedAt: Date.now() }
}

export const ACCOUNTS_FRESH_MS = 10 * 60_000

export function accountsQuery() {
  return queryOptions({
    queryKey: ["settings", "accounts"],
    queryFn: scanAccounts,
    staleTime: ACCOUNTS_FRESH_MS,
    gcTime: ACCOUNTS_FRESH_MS,
  })
}

export async function activateAccount(credentialIds: readonly string[]) {
  await request(`${CREDENTIALS}/activate`, { method: "POST", body: JSON.stringify({ ids: credentialIds }) })
}

export async function activateMachineLogin(providerIds: readonly string[]) {
  await request(`${CREDENTIALS}/activate`, { method: "POST", body: JSON.stringify({ machine_login: { provider_ids: providerIds } }) })
}

export async function removeAccount(credentialIds: readonly string[]) {
  for (const id of credentialIds) await request(`${CREDENTIALS}/${encodeURIComponent(id)}`, { method: "DELETE" })
}

export async function verifyAccount(credentialId: string): Promise<{ verdict: ProviderVerdict; usage?: QuotaWindow[] }> {
  const body: unknown = await (await request(`${CREDENTIALS}/${encodeURIComponent(credentialId)}/verify`, { method: "POST" })).json()
  const result = readString(body, "result")
  if (result === undefined || !isVerdict(result)) {
    throw { class: "internal", message: "Credential verification returned an invalid response", retryable: false } satisfies AppError
  }
  const usage = readUsageWindows(readField(body, "usage"))
  return { verdict: result, ...(usage ? { usage } : {}) }
}

export async function storeApiKey(input: { providerId: string; label: string; secret: string }): Promise<string> {
  const body: unknown = await (await request(CREDENTIALS, {
    method: "PUT",
    body: JSON.stringify({ provider_id: input.providerId, kind: "api_key", source: "local_only", scope: "local", label: input.label, secret: input.secret }),
  })).json()
  const id = readString(readField(body, "credential"), "id")
  if (!id) throw { class: "internal", message: "Credential save returned an invalid response", retryable: false } satisfies AppError
  return id
}
