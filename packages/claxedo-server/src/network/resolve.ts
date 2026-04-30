/**
 * Network resolution — converts hostnames and policy entries to CIDR blocks
 * for sandbox provider APIs that only accept IP-based allowlists.
 */

import { resolve4 } from "dns/promises"
import { Log } from "../log"
import { CONTROL_PLANE_HOSTS, DEFAULT_ALLOWLIST } from "./types"

const log = Log.create({ service: "network-resolve" })
const dns = ["1.1.1.1/32", "8.8.8.8/32"] as const

export type PolicyResolveMode = "full" | "cidr"

function loopback(host: string) {
  return host === "localhost" || host === "127.0.0.1"
}

async function hostToCidrs(host: string): Promise<string[]> {
  if (/^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(host)) {
    return [host.includes("/") ? host : `${host}/32`]
  }
  if (loopback(host)) {
    return ["127.0.0.1/32"]
  }
  const name = host.startsWith("*.") ? host.slice(2) : host
  try {
    const ips = await resolve4(name)
    return ips.map((ip) => `${ip}/32`)
  } catch {
    log.warn("Failed to resolve hostname for network policy", { host })
    return []
  }
}

export interface PolicyEntry {
  target: string
  kind: "host" | "domain" | "group"
}

export interface SandboxNetworkPolicy {
  mode: "allow-all" | "restricted"
  hosts: string[]
  cidrs: string[]
  rules: {
    target: string
    hosts: string[]
    cidrs: string[]
  }[]
}

function cidr(host: string) {
  return /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(host)
}

export async function resolveSandboxNetworkPolicy(
  entries: PolicyEntry[],
  serverUrl?: string,
  mode: PolicyResolveMode = "full",
): Promise<SandboxNetworkPolicy> {
  const hosts = new Set<string>()
  const cidrs = new Set<string>()
  const rules: SandboxNetworkPolicy["rules"] = []

  async function addRule(target: string, ruleHosts: string[]) {
    const nextHosts = new Set<string>()
    const nextCidrs = new Set<string>()
    for (const host of ruleHosts) {
      if (cidr(host)) {
        nextCidrs.add(host)
        cidrs.add(host)
        continue
      }
      nextHosts.add(host)
      for (const row of await hostToCidrs(host)) {
        nextCidrs.add(row)
        cidrs.add(row)
      }
    }
    if (mode === "cidr" && nextCidrs.size === 0) {
      log.warn("Skipping non-CIDR-resolvable network policy target for cidr-only provider", { target })
      return
    }
    for (const host of nextHosts) hosts.add(host)
    rules.push({
      target,
      hosts: [...nextHosts],
      cidrs: [...nextCidrs],
    })
  }

  // Always include control-plane
  for (const host of CONTROL_PLANE_HOSTS) await addRule(host, [host])

  // Daytona's CIDR-only firewall blocks DNS unless we explicitly allow
  // the resolver IPs used by the sandbox image.
  if (mode === "cidr" && entries.length > 0) {
    await addRule("dns", [...dns])
  }

  if (serverUrl) {
    try {
      const host = new URL(serverUrl).hostname
      await addRule(host, [host])
    } catch {}
  }

  // User-defined entries
  for (const entry of entries) {
    switch (entry.kind) {
      case "host":
        await addRule(entry.target, [entry.target])
        continue
      case "domain":
        await addRule(entry.target, [entry.target])
        continue
      case "group": {
        const items = DEFAULT_ALLOWLIST[entry.target] ?? []
        for (const item of items) await addRule(item, [item])
        continue
      }
    }
  }

  return {
    mode: entries.length > 0 ? "restricted" : "allow-all",
    hosts: [...hosts],
    cidrs: [...cidrs],
    rules,
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
