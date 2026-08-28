import { discoverAIConnections } from "@/features/onboarding/ai-connect-api"
import {
  groupDiscoveryItems,
  localHarnessChecks,
  localHarnessStatuses,
  type AIDiscoveryItem,
  type LocalHarnessStatus,
} from "@/features/onboarding/ai-connect-state"
import { claxedoCredentialRequest } from "@/platform/api/credential-request"

export async function listStoredCredentialProviders() {
  const res = await claxedoCredentialRequest(undefined)
  const body = await res.json() as { credentials?: unknown }
  if (!Array.isArray(body.credentials)) return new Set<string>()
  return new Set(
    body.credentials.flatMap((value) => {
      if (!value || typeof value !== "object") return []
      const providerId = (value as { provider_id?: unknown }).provider_id
      return typeof providerId === "string" ? [providerId] : []
    }),
  )
}

export function discoveryRowsFromItems(items: readonly AIDiscoveryItem[]) {
  return groupDiscoveryItems(items).map((row) => ({
    selectionId: row.selectionId,
    providerIds: row.providerIds,
    label: row.label,
    accountId: row.accountId,
    origin: row.origin,
    alreadyConnected: row.alreadyConnected,
    probe: row.probe,
    selected: row.selected,
  }))
}

export function agentSetupStatus(
  check: (typeof localHarnessChecks)[number],
  stored: ReadonlySet<string>,
  discovered: readonly LocalHarnessStatus[],
): { status: "connected" | "detected" | "broken" | "missing"; detail?: string } {
  if (check.providerIds.some((id) => stored.has(id))) {
    return { status: "connected" }
  }
  const row = discovered.find((item) => item.id === check.id)
  if (!row || row.state === "missing") return { status: "missing" }
  if (row.state === "broken") return { status: "broken", detail: row.detail }
  if (row.state === "working" || row.state === "unverifiable") {
    return { status: "detected", detail: row.detail }
  }
  return { status: "missing" }
}

export async function runProviderDetect() {
  const [discovery, stored] = await Promise.all([
    discoverAIConnections({}),
    listStoredCredentialProviders(),
  ])
  const rows = discoveryRowsFromItems(discovery.items)
  const agents = localHarnessStatuses(rows)
  return { discovery, rows, stored, agents }
}
