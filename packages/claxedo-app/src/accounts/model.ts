import { HARNESS_IDS, HARNESS_TABLE, harnessBindingIds, type HarnessId } from "@claxedo/agent-runtime-contract"
import type { Account, AccountDelivery, AccountSources, AccountVerdict, MachineLogin } from "@/server"

export type AccountReach = "local-and-cloud" | "local-only"

type QuotaWindow = NonNullable<Account["usage"]>[number]

export type AccountsSnapshot = {
  readonly stored: readonly Account[]
  readonly effective: ReadonlyMap<string, Account> | undefined
  readonly machineLogins: readonly MachineLogin[]
  readonly sources: AccountSources
  readonly scannedAt: number
}

export type LiveCheck = {
  readonly at: number
  readonly verdict?: AccountVerdict
  readonly usage?: readonly QuotaWindow[]
  readonly reason?: string
}

export type HarnessAccount = Account & { readonly ids: readonly string[]; readonly partialCloudConsent: boolean }

export type Harness = {
  readonly id: HarnessId
  readonly label: string
  readonly vendor: string
  readonly providerIds: readonly string[]
  readonly connectProvider: string
  readonly signIn: string
}

const SIGN_IN: Record<HarnessId, string> = { claude: "claude", codex: "codex login", cursor: "cursor-agent login" }

export const harnesses: readonly Harness[] = HARNESS_IDS.map((id) => ({
  id,
  label: HARNESS_TABLE[id].label,
  vendor: HARNESS_TABLE[id].vendor,
  providerIds: HARNESS_TABLE[id].providerIds,
  connectProvider: HARNESS_TABLE[id].connectProvider,
  signIn: SIGN_IN[id],
}))

export const MACHINE_LOGIN_KEY = "machine"

export const ORG_ACCOUNT_KEY = "org"

export const isRefusal = (verdict: string) => verdict === "auth_failed" || verdict === "no_billing" || verdict === "expired"

export const isUnavailable = (verdict: string) => verdict === "rate_capped" || verdict === "unknown"

export function accountReach(delivery: AccountDelivery | undefined): AccountReach | undefined {
  if (delivery === undefined) return "local-only"
  if (delivery.cloud) return "local-and-cloud"
  return delivery.local ? "local-only" : undefined
}

const OPAQUE_ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function accountIdentity(row: Account): { text: string; readable: boolean } | undefined {
  if (row.accountId === undefined) return undefined
  const fingerprint = /^fp_[0-9a-f]{8}(….+)$/.exec(row.accountId)
  if (fingerprint?.[1]) return { text: fingerprint[1], readable: true }
  return { text: row.accountId, readable: !OPAQUE_ACCOUNT_ID.test(row.accountId) }
}

export function accountLabel(row: Account): string {
  if (row.label && row.label !== row.providerId) return row.label
  const identity = accountIdentity(row)
  return identity?.readable ? identity.text : (row.kind ?? row.providerId)
}

function mergeGroup(ordered: readonly Account[]): HarnessAccount | undefined {
  const first = ordered[0]
  if (first === undefined) return undefined
  const pick = <K extends keyof Account>(key: K) => ordered.find((row) => row[key] !== undefined)?.[key]
  const usageRead = ordered.find((row) => row.usage !== undefined)
  const shared = ordered.some((row) => row.scope === "shared")
  const scope = shared ? "shared" : ordered.every((row) => row.scope === "local") ? "local" : undefined
  const delivery = ordered.find((row) => row.delivery?.cloud === false)?.delivery ?? (ordered.every((row) => row.delivery?.cloud === true) ? first.delivery : undefined)
  return {
    ...first,
    ids: ordered.map((row) => row.id),
    active: ordered.every((row) => row.active),
    scope,
    delivery,
    partialCloudConsent: shared && ordered.some((row) => row.scope !== "shared"),
    ...(pick("health") === undefined ? {} : { health: pick("health") }),
    ...(pick("lastValidatedAt") === undefined ? {} : { lastValidatedAt: pick("lastValidatedAt") }),
    ...(pick("expiresAt") === undefined ? {} : { expiresAt: pick("expiresAt") }),
    ...(usageRead?.usage === undefined ? {} : { usage: usageRead.usage, ...(usageRead.usageAt === undefined ? {} : { usageAt: usageRead.usageAt }) }),
  }
}

export function harnessAccounts(harness: Harness, rows: readonly Account[]): HarnessAccount[] {
  const groups = new Map<string, Account[]>()
  for (const row of rows) {
    if (!harness.providerIds.includes(row.providerId)) continue
    const identity = row.accountId ?? row.id
    groups.set(identity, [...(groups.get(identity) ?? []), row])
  }
  const accounts = [...groups.values()].flatMap((members) => {
    const ordered = [
      ...members.filter((row) => row.providerId === harness.connectProvider),
      ...members.filter((row) => row.providerId !== harness.connectProvider),
    ]
    const merged = mergeGroup(ordered)
    return merged ? [merged] : []
  })
  return [...accounts.filter((account) => account.active), ...accounts.filter((account) => !account.active)]
}

export function accountInUse(harness: Harness, effective: ReadonlyMap<string, Account>) {
  for (const id of harness.providerIds) {
    const row = effective.get(id)
    if (row) return row
  }
  return undefined
}

export function machineLoginOf(harness: Harness, snapshot: AccountsSnapshot) {
  return snapshot.machineLogins.find((login) => login.harness === harness.id)
}

export function partialMachineLogin(login: MachineLogin) {
  const serves = login.serves
  if (serves === undefined) return false
  const harness = harnesses.find((entry) => entry.id === login.harness)
  const bindings = harness ? harnessBindingIds(harness.id) : login.providerIds
  return bindings.some((id) => !serves.includes(id))
}

function ownAccountInUse(harness: Harness, snapshot: AccountsSnapshot) {
  const inUse = snapshot.effective ? accountInUse(harness, snapshot.effective) : undefined
  return inUse && snapshot.stored.some((row) => row.id === inUse.id) ? inUse : undefined
}

export function orgAccountOf(harness: Harness, snapshot: AccountsSnapshot): HarnessAccount | undefined {
  return harnessAccounts(harness, snapshot.sources.org)[0]
}

function harnessOnOrgAccount(harness: Harness, snapshot: AccountsSnapshot) {
  return harness.providerIds.length > 0 && harness.providerIds.every((id) => snapshot.sources.sources.get(id) === "org")
}

export function strandedBinding(login: MachineLogin, harness: Harness, snapshot: AccountsSnapshot) {
  const serves = login.serves
  if (serves === undefined) return false
  const inUse = ownAccountInUse(harness, snapshot)
  if (inUse === undefined) return false
  return harnessBindingIds(harness.id).includes(inUse.providerId) && !serves.includes(inUse.providerId)
}

export function selectedAccountKey(harness: Harness, snapshot: AccountsSnapshot): string | undefined {
  if (harnessOnOrgAccount(harness, snapshot)) return ORG_ACCOUNT_KEY
  const rows = harnessAccounts(harness, snapshot.stored)
  const inUse = ownAccountInUse(harness, snapshot)
  const match = inUse ? rows.find((row) => row.ids.includes(inUse.id)) : undefined
  if (match) return match.id
  const active = rows.find((row) => row.active)
  if (active) return active.id
  return machineLoginOf(harness, snapshot) ? MACHINE_LOGIN_KEY : undefined
}

export function storedCheck(row: HarnessAccount, live: LiveCheck | undefined): LiveCheck | undefined {
  if (live) return live
  const verdict = row.health !== undefined && row.health !== "unknown" && isVerdict(row.health) ? row.health : undefined
  if (verdict === undefined && row.usage === undefined) return undefined
  const at = row.usage === undefined ? row.lastValidatedAt : (row.usageAt ?? row.lastValidatedAt)
  if (at === undefined) return undefined
  return { at, ...(verdict === undefined ? {} : { verdict }), ...(row.usage === undefined ? {} : { usage: row.usage }) }
}

export function isVerdict(value: string): value is AccountVerdict {
  return value === "ok" || value === "auth_failed" || value === "no_billing" || value === "rate_capped" || value === "expired" || value === "unknown"
}

export function harnessRunnable(harness: Harness, snapshot: AccountsSnapshot, live: Readonly<Record<string, LiveCheck>>): boolean {
  const selected = selectedAccountKey(harness, snapshot)
  if (selected === undefined) return false
  if (selected === MACHINE_LOGIN_KEY) {
    const login = machineLoginOf(harness, snapshot)
    return login?.state === "signed_in" && !strandedBinding(login, harness, snapshot)
  }
  const row = selected === ORG_ACCOUNT_KEY ? orgAccountOf(harness, snapshot) : harnessAccounts(harness, snapshot.stored).find((account) => account.id === selected)
  const verdict = row ? storedCheck(row, live[row.id])?.verdict : undefined
  return row !== undefined && !(verdict !== undefined && isRefusal(verdict))
}
