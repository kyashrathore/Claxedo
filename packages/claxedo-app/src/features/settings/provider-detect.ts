import { claxedoCredentialRequest } from "@/platform/api/credential-request"
import {
  discoverAIConnections,
  groupDiscoveryItems,
  localHarnessStatuses,
  type AIDiscoveryRow,
  type LocalHarnessCheck,
  type LocalHarnessStatus,
} from "@/features/settings/app-ports"
import type { ProviderSetupStatus } from "@/features/settings/provider-settings-logic"
import { readArray, readBoolean, readFiniteNumber, readString } from "@/lib/record"

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
    }]
  })
}

export function storedCredentialProviders(rows: readonly StoredCredential[]) {
  return new Set(rows.map((row) => row.providerId))
}

/**
 * How an account names itself under a harness row: the identity its provider
 * gave it, or — for a pasted key the provider never named — the last characters
 * of the key, which are the ones the provider's own dashboard shows.
 */
export function accountIdentity(row: StoredCredential): string | undefined {
  if (row.accountId === undefined) return undefined
  const fingerprint = /^fp_[0-9a-f]{8}(….+)$/.exec(row.accountId)
  return fingerprint ? fingerprint[1] : row.accountId
}

/**
 * The accounts one harness row lists, active first.
 *
 * Across every provider id the harness binds, including the one its connect
 * card stores under, because a single Claude login is stored twice — once per
 * binding — and the list is of accounts, not of bindings.
 */
export function harnessAccounts(
  check: { providerIds: readonly string[] },
  rows: readonly StoredCredential[],
): StoredCredential[] {
  const bound = rows.filter((row) => check.providerIds.includes(row.providerId))
  return [...bound.filter((row) => row.isActive), ...bound.filter((row) => !row.isActive)]
}

/** Mark one stored account as the one its provider runs on. */
export async function activateCredential(credentialId: string) {
  await claxedoCredentialRequest({ action: "activate", credentialId }, { method: "POST" })
}

/**
 * What one harness row says, from the two things that can be known about it: a
 * credential Claxedo already holds, and what the last scan of this machine found.
 *
 * A stored credential outranks a scan because it is the thing a session will
 * actually run with. `unverifiable` reports as `detected` rather than
 * `connected`: the server has no verifier for it, so a tick would claim a proof
 * nothing performed.
 */
export function agentSetupStatus(
  check: { id: LocalHarnessCheck["id"]; providerIds: readonly string[] },
  stored: ReadonlySet<string>,
  discovered: readonly LocalHarnessStatus[],
): { status: ProviderSetupStatus; detail?: string } {
  if (check.providerIds.some((id) => stored.has(id))) return { status: "connected" }
  const row = discovered.find((item) => item.id === check.id)
  if (!row || row.state === "missing") return { status: "missing" }
  if (row.state === "broken") return { status: "broken", detail: row.detail }
  return { status: "detected", detail: row.detail }
}

export type ProviderDetectResult = {
  stored: StoredCredential[]
  effective: ReadonlyMap<string, EffectiveCredential> | undefined
  agents: LocalHarnessStatus[]
  /** The scan's id and rows, kept so a row can save the login it found without a second scan. */
  discoveryId: string
  rows: AIDiscoveryRow[]
}

/** One scan of this machine: the status inputs `agentSetupStatus` reads, plus the scan itself. */
export async function runProviderDetect(): Promise<ProviderDetectResult> {
  const [discovery, stored, effective] = await Promise.all([
    discoverAIConnections({}),
    listStoredCredentials(),
    listEffectiveCredentials(),
  ])
  const rows = groupDiscoveryItems(discovery.items)
  return { stored, effective, agents: localHarnessStatuses(rows), discoveryId: discovery.discoveryId, rows }
}
