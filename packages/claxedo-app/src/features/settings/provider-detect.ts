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
import { readArray, readString } from "@/lib/record"

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
  check: LocalHarnessCheck,
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
  agents: LocalHarnessStatus[]
  /** The scan's id and rows, kept so a row can save the login it found without a second scan. */
  discoveryId: string
  rows: AIDiscoveryRow[]
}

/** One scan of this machine: the status inputs `agentSetupStatus` reads, plus the scan itself. */
export async function runProviderDetect(): Promise<ProviderDetectResult> {
  const [discovery, stored] = await Promise.all([
    discoverAIConnections({}),
    listStoredCredentialProviders(),
  ])
  const rows = groupDiscoveryItems(discovery.items)
  return { stored, agents: localHarnessStatuses(rows), discoveryId: discovery.discoveryId, rows }
}
