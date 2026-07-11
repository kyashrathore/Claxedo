import { centralTransportForServer } from "@/shell/data/transport/transport"

export type PolicyKind = "host" | "domain" | "group"

export type PolicyEntry = {
  id: string
  target: string
  kind: PolicyKind
  constraints: {
    enabled?: boolean
    auto?: boolean
    source?: string
  }
}

export type NetworkPolicyGroups = Record<string, string[]>

export function shouldUseNetworkPolicyRows(input: { baseUrl?: string; workspaceId?: string }) {
  if (input.workspaceId?.trim()) return true
  if (!input.baseUrl) return true
  return centralTransportForServer(input.baseUrl) === "loopback"
}

export function networkPolicyRowsUrl(base: string, workspaceId?: string) {
  const url = networkPolicyUrl(base)
  if (workspaceId?.trim()) url.searchParams.set("workspace_id", workspaceId.trim())
  return String(url)
}

export function networkPolicyGroupsUrl(base: string) {
  return String(networkPolicyUrl(base, "/groups"))
}

export function networkPolicyRowUrl(base: string, id: string) {
  return String(networkPolicyUrl(base, `/${encodeURIComponent(id)}`))
}

export function policyKindFromValue(value: string): PolicyKind {
  if (value === "domain" || value === "group") return value
  return "host"
}

export function networkPolicyCreateBody(input: {
  workspaceId?: string
  target: string
  kind: PolicyKind
}) {
  return {
    ...(input.workspaceId?.trim() ? { workspace_id: input.workspaceId.trim() } : {}),
    target: input.target,
    kind: input.kind,
  }
}

export function parsePolicyEntries(input: unknown): PolicyEntry[] {
  if (!isRecord(input) || !Array.isArray(input.policies)) return []
  return input.policies.flatMap((item) => {
    if (!isRecord(item)) return []
    if (typeof item.id !== "string" || typeof item.target !== "string") return []
    if (!isPolicyKind(item.kind)) return []
    return [{
      id: item.id,
      target: item.target,
      kind: item.kind,
      constraints: parseConstraints(item.constraints),
    }]
  })
}

export function parsePolicyGroups(input: unknown): NetworkPolicyGroups {
  if (!isRecord(input) || !isRecord(input.groups)) return {}
  return Object.fromEntries(
    Object.entries(input.groups).flatMap(([name, hosts]) => {
      if (!Array.isArray(hosts)) return []
      return [[name, hosts.filter((host) => typeof host === "string")]]
    }),
  )
}

export function policyEntryLabel(entry: PolicyEntry) {
  if (!entry.constraints.source) return entry.target
  const parts = entry.constraints.source.split(":")
  if (parts.length <= 1) return entry.target
  return parts.slice(1).join(":")
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object"
}

function isPolicyKind(input: unknown): input is PolicyKind {
  return input === "host" || input === "domain" || input === "group"
}

function networkPolicyUrl(base: string, suffix = "") {
  return new URL(`/api/claxedo/network-policy${suffix}`, base)
}

function parseConstraints(input: unknown): PolicyEntry["constraints"] {
  if (!isRecord(input)) return {}
  return {
    ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
    ...(typeof input.auto === "boolean" ? { auto: input.auto } : {}),
    ...(typeof input.source === "string" ? { source: input.source } : {}),
  }
}
