/**
 * Network resolution — converts hostnames and policy entries to CIDR blocks
 * for sandbox driver APIs that only accept IP-based allowlists.
 *
 * Daytona: comma-separated IPv4 CIDR blocks via `networkAllowList`
 * Modal: list of CIDR ranges via `cidr_allowlist`
 */

import { resolve4 } from "dns/promises"
import { formatDaytonaAllowList } from "./daytona-allow-list"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { CONTROL_PLANE_HOSTS, DEFAULT_ALLOWLIST } from "@claxedo/server-core/sandbox/network/types"

export { formatDaytonaAllowList }

const log = Log.create({ service: "network-resolve" })

/**
 * Resolve a hostname to its IPv4 addresses as /32 CIDRs.
 * Returns empty array on resolution failure.
 */
async function hostToCidrs(host: string): Promise<string[]> {
  // Already an IP or CIDR
  if (/^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(host)) {
    return [host.includes("/") ? host : `${host}/32`]
  }
  try {
    const ips = await resolve4(host)
    return ips.map((ip) => `${ip}/32`)
  } catch {
    log.warn("Failed to resolve hostname for network policy", { host })
    return []
  }
}

async function domainToCidrs(host: string): Promise<string[]> {
  return hostToCidrs(host.replace(/^\*\./, ""))
}

// Preset groups expand to the host list keyed by `name` in
// `DEFAULT_ALLOWLIST` (see `network/types.ts`). Wildcard entries are added via
// `addDomain`; literal hostnames go through `addHost`. DNS-resolver IPs
// (1.1.1.1, 8.8.8.8) are included as a baseline for sandbox networks that lock
// outbound traffic to a CIDR allowlist.
async function addPreset(hosts: Set<string>, cidrs: Set<string>, name: string): Promise<void> {
  const list = DEFAULT_ALLOWLIST[name]
  if (!list) return
  for (const host of list) {
    if (host.startsWith("*.")) {
      await addDomain(hosts, cidrs, host)
    } else {
      await addHost(hosts, cidrs, host)
    }
  }
  for (const dns of ["1.1.1.1", "8.8.8.8"]) cidrs.add(`${dns}/32`)
}

export interface PolicyEntry {
  target: string
  kind: "host" | "domain" | "group"
}

export interface SandboxNetworkPolicyRule {
  target: string
  hosts: string[]
  cidrs: string[]
}

export interface SandboxNetworkPolicy {
  mode: "allow-all" | "restricted"
  hosts: string[]
  cidrs: string[]
  rules?: SandboxNetworkPolicyRule[]
}

function cidr(host: string) {
  return /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(host)
}

async function addHost(hosts: Set<string>, cidrs: Set<string>, host: string) {
  if (!host) return
  hosts.add(host)
  for (const row of await hostToCidrs(host)) cidrs.add(row)
}

async function addDomain(hosts: Set<string>, cidrs: Set<string>, host: string) {
  if (!host) return
  hosts.add(host)
  for (const row of await domainToCidrs(host)) cidrs.add(row)
}

async function addEntry(hosts: Set<string>, cidrs: Set<string>, entry: PolicyEntry) {
  switch (entry.kind) {
    case "host":
      if (cidr(entry.target)) {
        cidrs.add(entry.target)
        return
      }
      await addHost(hosts, cidrs, entry.target)
      return
    case "domain":
      await addDomain(hosts, cidrs, entry.target)
      return
    case "group":
      await addPreset(hosts, cidrs, entry.target)
      return
  }
}

export async function resolveSandboxNetworkPolicy(
  entries: PolicyEntry[],
  serverUrl?: string,
): Promise<SandboxNetworkPolicy> {
  const hosts = new Set<string>()
  const cidrs = new Set<string>()

  // Always include control-plane CIDRs. Presets are resolved lazily only when a
  // policy entry names the group, avoiding many DNS lookups on every call.
  for (const host of CONTROL_PLANE_HOSTS) await addHost(hosts, cidrs, host)

  if (serverUrl) {
    try { await addHost(hosts, cidrs, new URL(serverUrl).hostname) } catch {}
  }

  const rules: SandboxNetworkPolicyRule[] = []

  for (const entry of entries) {
    const ruleHosts = new Set<string>()
    const ruleCidrs = new Set<string>()
    await addEntry(ruleHosts, ruleCidrs, entry)
    for (const host of ruleHosts) hosts.add(host)
    for (const cidr of ruleCidrs) cidrs.add(cidr)
    rules.push({
      target: entry.target,
      hosts: [...ruleHosts],
      cidrs: [...ruleCidrs],
    })
  }

  return {
    mode: entries.length > 0 ? "restricted" : "allow-all",
    hosts: [...hosts],
    cidrs: [...cidrs],
    ...(rules.length ? { rules } : {}),
  }
}

/**
 * Resolve a list of policy entries to a deduplicated CIDR allowlist string
 * suitable for Daytona's `networkAllowList` parameter.
 *
 * Always includes Claxedo control-plane CIDRs so the sandbox can
 * communicate with the gateway server.
 *
 * @param entries - User-configured policy entries
 * @param serverUrl - The claxedo-server URL the sandbox needs to reach
 * @returns Comma-separated CIDR string, or undefined if no entries
 */
export async function resolveAllowListCidrs(
  entries: PolicyEntry[],
  serverUrl?: string,
): Promise<string[]> {
  return (await resolveSandboxNetworkPolicy(entries, serverUrl)).cidrs
}
