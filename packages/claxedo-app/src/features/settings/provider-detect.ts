import { claxedoCredentialRequest } from "@/platform/api/credential-request"
import { readMachineLogins, useMachineLogin, type MachineLogin } from "@/features/settings/app-ports"
import { readArray, readBoolean, readField, readFiniteNumber, readString } from "@/lib/record"

/** What the server would hand a harness for a provider: the row, without its secret. */
export type EffectiveCredential = {
  id: string
  providerId: string
  label?: string
  kind?: string
  accountId?: string
  /** The last provider verdict the server stored for the row, and when. */
  health?: string
  lastValidatedAt?: number
}

/**
 * The credential each provider runs on, keyed by provider id. Undefined when
 * the host cannot enumerate its store (the hosted KV adapter), so a caller
 * shows nothing rather than a wrong "machine login".
 */
export async function listEffectiveCredentials() {
  const res = await claxedoCredentialRequest({ action: "effective" }, { accept: [501] })
  if (res.status === 501) return undefined
  const rows = readArray(await res.json(), "credentials") ?? []
  const effective = new Map<string, EffectiveCredential>()
  for (const row of rows) {
    const id = readString(row, "id")
    const providerId = readString(row, "provider_id")
    if (id === undefined || providerId === undefined) continue
    const label = readString(row, "label")
    const kind = readString(row, "kind")
    const accountId = readString(row, "account_id")
    const health = readString(row, "health")
    const lastValidatedAt = readFiniteNumber(row, "last_validated_at")
    effective.set(providerId, {
      id,
      providerId,
      ...(label === undefined ? {} : { label }),
      ...(kind === undefined ? {} : { kind }),
      ...(accountId === undefined ? {} : { accountId }),
      ...(health === undefined ? {} : { health }),
      ...(lastValidatedAt === undefined ? {} : { lastValidatedAt }),
    })
  }
  return effective
}

/**
 * The stored credential a harness row runs on, if any. Absent means the
 * harness runs on whatever login its own CLI holds on this computer.
 */
export function agentInUse(check: { providerIds: readonly string[] }, effective: ReadonlyMap<string, EffectiveCredential>) {
  for (const id of check.providerIds) {
    const row = effective.get(id)
    if (row) return row
  }
  return undefined
}

/** One account the server holds for a provider, as the accounts list shows it. */
export type StoredCredential = EffectiveCredential & {
  isActive: boolean
  expiresAt?: number
  /** The surface the account was stored from; the machine scan is one of them. */
  consentSurface?: string
}

/** Every account the server holds, in the order the store listed them. */
export async function listStoredCredentials(): Promise<StoredCredential[]> {
  const res = await claxedoCredentialRequest(undefined)
  const rows = readArray(await res.json(), "credentials") ?? []
  return rows.flatMap((row) => {
    const id = readString(row, "id")
    const providerId = readString(row, "provider_id")
    if (id === undefined || providerId === undefined) return []
    const label = readString(row, "label")
    const kind = readString(row, "kind")
    const accountId = readString(row, "account_id")
    const health = readString(row, "health")
    const lastValidatedAt = readFiniteNumber(row, "last_validated_at")
    const expiresAt = readFiniteNumber(row, "expires_at")
    const consentSurface = readString(readField(row, "consent"), "surface")
    return [{
      id,
      providerId,
      isActive: readBoolean(row, "is_active") === true,
      ...(label === undefined ? {} : { label }),
      ...(kind === undefined ? {} : { kind }),
      ...(accountId === undefined ? {} : { accountId }),
      ...(health === undefined ? {} : { health }),
      ...(lastValidatedAt === undefined ? {} : { lastValidatedAt }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(consentSurface === undefined ? {} : { consentSurface }),
    }]
  })
}

/**
 * How an account names itself under a harness row: the identity its provider
 * gave it, or — for a pasted key the provider never named — the last characters
 * of the key, which are the ones the provider's own dashboard shows.
 *
 * `readable` is false for an opaque id. A ChatGPT account UUID names nothing a
 * reader can match to an account, and every real Codex row carries one, so a
 * surface shows it only where a full value belongs.
 */
export function accountIdentity(row: StoredCredential): { text: string; readable: boolean } | undefined {
  if (row.accountId === undefined) return undefined
  const fingerprint = /^fp_[0-9a-f]{8}(….+)$/.exec(row.accountId)
  if (fingerprint?.[1]) return { text: fingerprint[1], readable: true }
  return { text: row.accountId, readable: !OPAQUE_ACCOUNT_ID.test(row.accountId) }
}

const OPAQUE_ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One account, however many of the harness's bindings store it.
 *
 * `ids` are those rows, the connect provider's first, and `id` is that first
 * one — the row the list is keyed by and the one whose fields the account
 * shows.
 */
export type HarnessAccount = StoredCredential & { ids: string[] }

/**
 * The accounts one harness row lists, active first.
 *
 * One Claude login is saved once per binding — `claude-acp` and `claude-sdk`
 * are two rows carrying the same `account_id` — so listing rows would show the
 * account twice and let a switch mark one binding while the other kept the old
 * account. Rows are grouped by the identity their provider gave them, an
 * unnamed row standing alone, and a group counts as active only when every one
 * of its rows is.
 */
export function harnessAccounts(
  check: { providerIds: readonly string[]; connectProviderId?: string },
  rows: readonly StoredCredential[],
): HarnessAccount[] {
  const groups = new Map<string, StoredCredential[]>()
  for (const row of rows) {
    if (!check.providerIds.includes(row.providerId)) continue
    const identity = row.accountId ?? row.id
    groups.set(identity, [...(groups.get(identity) ?? []), row])
  }

  const accounts = [...groups.values()].flatMap((members) => {
    const ordered = [
      ...members.filter((row) => row.providerId === check.connectProviderId),
      ...members.filter((row) => row.providerId !== check.connectProviderId),
    ]
    const first = ordered[0]
    if (first === undefined) return []
    const health = ordered.find((row) => row.health !== undefined)?.health
    const lastValidatedAt = ordered.find((row) => row.lastValidatedAt !== undefined)?.lastValidatedAt
    const expiresAt = ordered.find((row) => row.expiresAt !== undefined)?.expiresAt
    return [{
      ...first,
      ids: ordered.map((row) => row.id),
      isActive: ordered.every((row) => row.isActive),
      ...(health === undefined ? {} : { health }),
      ...(lastValidatedAt === undefined ? {} : { lastValidatedAt }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }]
  })
  return [...accounts.filter((account) => account.isActive), ...accounts.filter((account) => !account.isActive)]
}

/**
 * Mark one account as the one its providers run on, naming every row that
 * stores it so the server moves all of its bindings or none of them.
 */
export async function activateCredential(credentialIds: readonly string[]) {
  await claxedoCredentialRequest({ action: "activate" }, {
    method: "POST",
    body: JSON.stringify({ ids: credentialIds }),
  })
}

/**
 * Forget one account, naming every row that stores it, so a login saved once
 * per binding cannot survive under the binding the list stopped showing.
 *
 * The rows go one at a time because each removal is its own decision about
 * which account that provider runs on next.
 */
export async function removeCredential(credentialIds: readonly string[]) {
  for (const id of credentialIds) {
    await claxedoCredentialRequest({ credentialId: id }, { method: "DELETE" })
  }
}

/**
 * Leave a harness's providers with no marked account, which is what makes it run
 * on the login its own CLI holds. Never a save: that login is not ours to copy.
 */
export async function activateMachineLogin(providerIds: readonly string[]) {
  await useMachineLogin({ providerIds })
}

export type ProviderDetectResult = {
  stored: StoredCredential[]
  effective: ReadonlyMap<string, EffectiveCredential> | undefined
  /** What each harness on this machine says about the login it would run on. */
  machineLogins: MachineLogin[]
}

/** One read of this machine's harnesses, with the store read alongside it. */
export async function runProviderDetect(): Promise<ProviderDetectResult> {
  const [machineLogins, stored, effective] = await Promise.all([
    readMachineLogins({}),
    listStoredCredentials(),
    listEffectiveCredentials(),
  ])
  return { stored, effective, machineLogins }
}
