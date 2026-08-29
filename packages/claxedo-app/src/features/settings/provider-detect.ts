import { claxedoCredentialRequest } from "@/platform/api/credential-request"
import {
  discoverAIConnections,
  groupDiscoveryItems,
  localHarnessChecks,
  localHarnessStatuses,
  type AIDiscoveryItem,
  type LocalHarnessStatus,
} from "@/features/settings/app-ports"

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
  return groupDiscoveryItems(items)
}

export function agentSetupStatus(
  check: ReturnType<typeof localHarnessChecks>[number],
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
