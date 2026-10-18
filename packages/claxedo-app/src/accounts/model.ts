import { HARNESS_IDS, HARNESS_TABLE, harnessBindingIds, piProviderSpending, type HarnessId } from "@claxedo/agent-runtime-contract"
import { isRefusal } from "@/lib/account-health"
import { harnessDisplayLabel } from "@/lib/harness-catalog"
import type { Account, AccountSources, AccountVerdict, MachineLogin, ProviderSource } from "@/server"

export { isRefusal, isUnavailable } from "@/lib/account-health"

type QuotaWindow = NonNullable<Account["usage"]>[number]

export type AccountsSnapshot = {
  readonly cloudOnly: boolean
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
  readonly uncheckable?: true
}

export type HarnessAccount = Account & { readonly ids: readonly string[]; readonly partialCloudConsent: boolean }

export type Harness = {
  readonly id: HarnessId
  readonly label: string
  readonly vendor: string
  readonly providerIds: readonly string[]
  readonly connectProvider: string
  readonly vendorProvider: string
  readonly signIn: string
}

const SIGN_IN: Record<HarnessId, string> = { claude: "claude", codex: "codex login", cursor: "cursor-agent login" }

export const harnesses: readonly Harness[] = HARNESS_IDS.map((id) => ({
  id,
  label: HARNESS_TABLE[id].label,
  vendor: HARNESS_TABLE[id].vendor,
  providerIds: HARNESS_TABLE[id].providerIds,
  connectProvider: HARNESS_TABLE[id].connectProvider,
  vendorProvider: HARNESS_TABLE[id].vendorProvider,
  signIn: SIGN_IN[id],
}))

export const MACHINE_LOGIN_KEY = "machine"

export const ORG_ACCOUNT_KEY = "org"

export function machineCheckKey(harness: Harness): string {
  return `${MACHINE_LOGIN_KEY}:${harness.id}`
}

export function harnessesServedBy(providerIds: readonly string[]): readonly string[] {
  const cli = harnesses.filter((harness) => providerIds.some((id) => harness.providerIds.includes(id))).map((harness) => harness.label)
  const engines = providerIds.some((id) => piProviderSpending(id) !== undefined) ? [harnessDisplayLabel("pi")] : []
  return [...cli, ...engines]
}

export function servedByList(providerIds: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(harnessesServedBy(providerIds))
}

const OPAQUE_ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const KEY_MASK = "•••••"

export function accountIdentity(row: Account): { text: string; readable: boolean } | undefined {
  if (row.keyHint) return { text: `${row.keyHint.prefix}${KEY_MASK}${row.keyHint.tail}`, readable: true }
  if (row.accountId === undefined) return undefined
  const fingerprint = /^fp_[0-9a-f]{8}…(.+)$/.exec(row.accountId)
  if (fingerprint?.[1]) return { text: `${KEY_MASK}${fingerprint[1]}`, readable: true }
  return { text: row.accountId, readable: !OPAQUE_ACCOUNT_ID.test(row.accountId) }
}

export function canDisconnectProvider(source: ProviderSource | undefined): boolean {
  return source === "api" || source === "custom"
}

export function providerOwnKeys(provider: { readonly id: string; readonly source?: ProviderSource }, stored: readonly Account[]): readonly Account[] {
  if (!canDisconnectProvider(provider.source)) return []
  return stored.filter((account) => account.providerId === provider.id && account.hasSecret)
}

export function accountLabel(row: Account): string {
  if (row.label && row.label !== row.providerId) return row.label
  const identity = accountIdentity(row)
  return identity?.readable ? identity.text : (row.kind ?? row.providerId)
}

export function replacedAccountLabel(providerId: string, snapshot: AccountsSnapshot, methodType: string): string | undefined {
  const rows = snapshot.stored.filter((row) => row.providerId === providerId)
  const replaced = snapshot.cloudOnly ? rows[0] : methodType === "token" ? rows.find((row) => row.kind === "oauth_token") : undefined
  return replaced ? accountLabel(replaced) : undefined
}

export type OrganizationTarget = { readonly vendorProvider: string; readonly replaces: string | undefined }

export function organizationTarget(harness: Harness, snapshot: AccountsSnapshot, manages: boolean): OrganizationTarget | undefined {
  if (!manages) return undefined
  const replaced = snapshot.sources.org.find((row) => row.providerId === harness.vendorProvider)
  return { vendorProvider: harness.vendorProvider, replaces: replaced ? accountLabel(replaced) : undefined }
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

export function accountInUse(harness: Harness, effective: ReadonlyMap<string, Account>, cloudOnly: boolean) {
  const marked = harness.providerIds.flatMap((id) => {
    const row = effective.get(id)
    return row ? [row] : []
  })
  if (!cloudOnly) return marked[0]
  return marked
    .filter((row) => row.delivery?.cloud === true)
    .reduce<Account | undefined>((latest, row) => (latest && (latest.activatedAt ?? 0) >= (row.activatedAt ?? 0) ? latest : row), undefined)
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
  const inUse = snapshot.effective ? accountInUse(harness, snapshot.effective, snapshot.cloudOnly) : undefined
  return inUse && snapshot.stored.some((row) => row.id === inUse.id) ? inUse : undefined
}

export function orgAccountOf(harness: Harness, snapshot: AccountsSnapshot): HarnessAccount | undefined {
  return harnessAccounts(harness, snapshot.sources.org)[0]
}

function harnessOnOrgAccount(harness: Harness, snapshot: AccountsSnapshot) {
  return harness.providerIds.length > 0 && harness.providerIds.every((id) => snapshot.sources.sources.get(id) === "org")
}

export function harnessHasAccount(harness: Harness, snapshot: AccountsSnapshot): boolean {
  if (harnessAccounts(harness, snapshot.stored).length > 0 || machineLoginOf(harness, snapshot)) return true
  return orgAccountOf(harness, snapshot) !== undefined || harnessOnOrgAccount(harness, snapshot)
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
  if (row === undefined || (snapshot.cloudOnly && row.delivery?.cloud !== true)) return false
  const verdict = storedCheck(row, live[row.id])?.verdict
  return !(verdict !== undefined && isRefusal(verdict))
}
