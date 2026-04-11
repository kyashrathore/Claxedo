/**
 * Network resolution — converts hostnames and policy entries to CIDR blocks
 * for sandbox provider APIs that only accept IP-based allowlists.
 */

import { resolve4 } from "dns/promises"
import { Log } from "../log"
import { CONTROL_PLANE_HOSTS, DEFAULT_ALLOWLIST, flattenDefaultAllowlist } from "./types"

const log = Log.create({ service: "network-resolve" })

async function hostToCidrs(host: string): Promise<string[]> {
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

async function domainToCidrs(pattern: string): Promise<string[]> {
  const base = pattern.replace(/^\*\./, "")
  return hostToCidrs(base)
}

export interface PolicyEntry {
  target: string
  kind: "host" | "domain" | "group"
}

export interface SandboxNetworkPolicy {
  mode: "allow-all" | "restricted"
  hosts: string[]
  cidrs: string[]
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

export async function resolveSandboxNetworkPolicy(
  entries: PolicyEntry[],
  serverUrl?: string,
): Promise<SandboxNetworkPolicy> {
  const hosts = new Set<string>()
  const cidrs = new Set<string>()

  // Always include control-plane
  for (const host of CONTROL_PLANE_HOSTS) await addHost(hosts, cidrs, host)

  if (serverUrl) {
    try { await addHost(hosts, cidrs, new URL(serverUrl).hostname) } catch {}
  }

  // User-defined entries
  for (const entry of entries) {
    switch (entry.kind) {
      case "host":
        if (cidr(entry.target)) { cidrs.add(entry.target); continue }
        await addHost(hosts, cidrs, entry.target)
        continue
      case "domain":
        await addDomain(hosts, cidrs, entry.target)
        continue
      case "group": {
        const items = DEFAULT_ALLOWLIST[entry.target] ?? []
        for (const h of items) await addHost(hosts, cidrs, h)
        continue
      }
    }
  }

  return {
    mode: entries.length > 0 ? "restricted" : "allow-all",
    hosts: [...hosts],
    cidrs: [...cidrs],
  }
}

export async function resolveAllowListCidrs(
  entries: PolicyEntry[],
  serverUrl?: string,
): Promise<string[]> {
  return (await resolveSandboxNetworkPolicy(entries, serverUrl)).cidrs
}

export function formatDaytonaAllowList(cidrs: string[]): string {
  if (cidrs.length > 10) {
    log.warn("Network allowlist exceeds Daytona limit of 10 entries, truncating", { total: cidrs.length })
  }
  return cidrs.slice(0, 10).join(",")
}
