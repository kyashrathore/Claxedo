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
import { readArray, readFiniteNumber, readString } from "@/lib/record"

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

export async function listStoredCredentialProviders() {
  const res = await claxedoCredentialRequest(undefined)
  const credentials = readArray(await res.json(), "credentials") ?? []
  return new Set(credentials.flatMap((value) => {
    const providerId = readString(value, "provider_id")
    return providerId === undefined ? [] : [providerId]
  }))
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
  stored: ReadonlySet<string>
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
    listStoredCredentialProviders(),
    listEffectiveCredentials(),
  ])
  const rows = groupDiscoveryItems(discovery.items)
  return { stored, effective, agents: localHarnessStatuses(rows), discoveryId: discovery.discoveryId, rows }
}
