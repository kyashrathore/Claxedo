import { randomUUID } from "crypto"
import { collectLocalCredentialItems, localCredentialKey, type LocalCredentialItem } from "./sync"
import { probeDiscoveredCredential } from "./probe"
import type { CredentialUsageWindow } from "./verify"
import { listCredentials, putCredential, updateCredentialHealth } from "@claxedo/server-core/credentials/registry"
import type { CredentialHealth, CredentialScope, CredentialWrite } from "@claxedo/server-core/credentials/types"

const ttl = 5 * 60 * 1000

/**
 * What a live probe said about a discovered candidate.
 *
 * `unknown` is a real answer, not a failure to get one: a provider we cannot
 * probe (no verifier for it) or a network fault says nothing about the
 * credential, and must not be presented as either working or broken.
 */
export type CredentialProbe =
  | { state: "working"; usage?: CredentialUsageWindow[] }
  | { state: "broken"; reason: string }
  | { state: "unknown"; reason: string }

/**
 * A probe plus the verdict it came from, where it reached one. `unknown` is the
 * absence of a verdict and so carries no health.
 */
export type CredentialDiscoveryProbe = CredentialProbe & { health?: CredentialHealth }

export type CredentialDiscoveryPreview = {
  provider_id: string
  kind: LocalCredentialItem["kind"]
  label: string
  origin: string
  already_connected?: boolean
  probe?: CredentialProbe
}

export type CredentialDiscoverySelection = {
  provider_id: string
  kind: LocalCredentialItem["kind"]
  scope: CredentialScope
}

export type CredentialDiscoveryErrorCode =
  | "discovery_not_found"
  | "discovery_expired"
  | "discovery_item_not_found"
  | "discovery_duplicate_item"
  | "discovery_org_mismatch"

export class CredentialDiscoveryError extends Error {
  constructor(public readonly code: CredentialDiscoveryErrorCode) {
    super(`credential discovery failed: ${code}`)
    this.name = "CredentialDiscoveryError"
  }
}

function preview(
  item: LocalCredentialItem,
  connected: Set<string>,
  probe?: CredentialDiscoveryProbe,
): CredentialDiscoveryPreview {
  return {
    provider_id: item.provider_id,
    kind: item.kind,
    label: item.label,
    origin: item.origin,
    ...(connected.has(localCredentialKey(item)) ? { already_connected: true } : {}),
    ...(probe ? { probe } : {}),
  }
}

export function createCredentialDiscovery(input: {
  collect: () => Promise<LocalCredentialItem[]>
  save: (item: CredentialWrite, org?: string) => Promise<{ id: string }>
  connected?: (org?: string) => Array<{ provider_id: string; kind: LocalCredentialItem["kind"] }>
  /**
   * Live-probes a candidate before it is offered. Omitted (or throwing) leaves
   * every row `unknown` — discovery still works, it just cannot promise
   * anything, which is the honest degradation.
   */
  probe?: (item: LocalCredentialItem) => Promise<CredentialDiscoveryProbe>
  /**
   * Writes the verdict the discovery probe already reached onto the row that
   * was just saved, so a freshly saved account reads as checked without
   * spending a second request against the user's own quota.
   */
  recordHealth?: (id: string, health: CredentialHealth, validatedAt: number, org?: string) => void | Promise<void>
  now?: () => number
  id?: () => string
}) {
  const stash = new Map<string, {
    expiresAt: number
    org?: string
    items: Map<string, { item: LocalCredentialItem; probe: CredentialDiscoveryProbe }>
  }>()
  const now = input.now ?? Date.now

  /**
   * A probe that throws is an unknown, never a broken: a DNS failure or an
   * offline laptop must not tell the user their credential is bad.
   */
  async function runProbe(item: LocalCredentialItem): Promise<CredentialDiscoveryProbe> {
    if (!input.probe) return { state: "unknown", reason: "This credential can't be checked here." }
    try {
      return await input.probe(item)
    } catch (error) {
      return {
        state: "unknown",
        reason: error instanceof Error && error.message
          ? `Couldn't reach the provider: ${error.message}`
          : "Couldn't reach the provider to check this.",
      }
    }
  }

  return {
    async discover(org?: string) {
      const collected = await input.collect()
      const discovery_id = (input.id ?? randomUUID)()
      const connected = new Set((input.connected?.(org) ?? []).map(localCredentialKey))
      // Probe every candidate before offering it. Reading a token off disk says
      // nothing about whether the provider will accept it, and a credential that
      // is saved and then fails is worse than one that was never found — the
      // user believes setup succeeded. Probes run in parallel and are resolved
      // once per discovery, so the result is stashed rather than re-spent.
      const probes = await Promise.all(collected.map((item) => runProbe(item)))
      const items = new Map(collected.map((item, index) => [
        localCredentialKey(item),
        { item, probe: probes[index] },
      ]))
      stash.set(discovery_id, { expiresAt: now() + ttl, org, items })
      const timer = setTimeout(() => stash.delete(discovery_id), ttl)
      timer.unref?.()
      return {
        discovery_id,
        items: collected.map((item, index) => preview(item, connected, probes[index])),
      }
    },
    async save(request: { discovery_id: string; items: CredentialDiscoverySelection[] }, org?: string) {
      const discovery = stash.get(request.discovery_id)
      if (!discovery) throw new CredentialDiscoveryError("discovery_not_found")
      if (now() > discovery.expiresAt) throw new CredentialDiscoveryError("discovery_expired")
      if (org !== discovery.org) throw new CredentialDiscoveryError("discovery_org_mismatch")

      const keys = request.items.map(localCredentialKey)
      if (new Set(keys).size !== keys.length) throw new CredentialDiscoveryError("discovery_duplicate_item")
      const selected = keys.flatMap((key) => {
        const entry = discovery.items.get(key)
        return entry ? [entry] : []
      })
      if (selected.length !== keys.length) throw new CredentialDiscoveryError("discovery_item_not_found")

      const credentials = await Promise.all(selected.map(({ item }, index) => input.save({
        provider_id: item.provider_id,
        kind: item.kind,
        source: request.items[index].scope === "shared" ? "managed" : "local_only",
        label: item.label,
        secret: item.secret,
        scope: request.items[index].scope,
        consent: { at: now(), surface: "desktop_discovery" },
      }, org)))
      const validatedAt = now()
      for (const [index, { probe }] of selected.entries()) {
        if (probe.health && input.recordHealth) {
          await input.recordHealth(credentials[index].id, probe.health, validatedAt, org)
        }
      }
      stash.delete(request.discovery_id)

      return {
        saved: request.items.map((item, index) => ({
          credential_id: credentials[index].id,
          provider_id: item.provider_id,
          kind: item.kind,
        })),
      }
    },
  }
}

export const credentialDiscovery = createCredentialDiscovery({
  collect: collectLocalCredentialItems,
  save: putCredential,
  connected: listCredentials,
  probe: probeDiscoveredCredential,
  recordHealth: updateCredentialHealth,
})
