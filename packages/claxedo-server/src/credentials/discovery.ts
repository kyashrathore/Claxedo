import { createHmac, randomBytes, randomUUID } from "crypto"
import { collectLocalCredentialItems, type LocalCredentialItem } from "./sync"
import { probeDiscoveredCredential } from "./probe"
import { listCredentials, putCredential } from "./registry"
import type { CredentialScope, CredentialWrite } from "./types"

const ttl = 5 * 60 * 1000

/**
 * What a live probe said about a discovered candidate.
 *
 * `unknown` is a real answer, not a failure to get one: a provider we cannot
 * probe (no verifier for it) or a network fault says nothing about the
 * credential, and must not be presented as either working or broken.
 */
export type CredentialProbe =
  | { state: "working" }
  | { state: "broken"; reason: string }
  | { state: "unknown"; reason: string }

export type CredentialDiscoveryPreview = {
  provider_id: string
  kind: LocalCredentialItem["kind"]
  label: string
  account_id?: string
  origin: string
  fresh_until?: number
  already_connected?: boolean
  probe?: CredentialProbe
}

export type CredentialDiscoverySelection = {
  provider_id: string
  account_id?: string
  scope: CredentialScope
}

export class CredentialDiscoveryError extends Error {
  constructor(
    public readonly code:
      | "discovery_not_found"
      | "discovery_expired"
      | "discovery_item_not_found"
      | "discovery_duplicate_item"
      | "discovery_org_mismatch",
  ) {
    super(code)
  }
}

function maskedAccountId(accountId: string, maskKey: Buffer) {
  return `account…${createHmac("sha256", maskKey).update(accountId).digest("hex").slice(0, 10)}`
}

function preview(
  item: LocalCredentialItem,
  maskKey: Buffer,
  connected: Set<string>,
  probe?: CredentialProbe,
): CredentialDiscoveryPreview {
  return {
    provider_id: item.provider_id,
    kind: item.kind,
    label: item.label,
    ...(item.account_id ? { account_id: maskedAccountId(item.account_id, maskKey) } : {}),
    origin: item.origin,
    ...(item.fresh_until ? { fresh_until: item.fresh_until } : {}),
    ...(connected.has(selectionKey(item)) ? { already_connected: true } : {}),
    ...(probe ? { probe } : {}),
  }
}

function selectionKey(input: { provider_id: string; account_id?: string | null }) {
  return `${input.provider_id}\u0000${input.account_id ?? ""}`
}

export function createCredentialDiscovery(input: {
  collect: () => Promise<LocalCredentialItem[]>
  save: (item: CredentialWrite, org?: string) => Promise<{ id: string }>
  connected?: (org?: string) => Array<{ provider_id: string; account_id?: string | null }>
  /**
   * Live-probes a candidate before it is offered. Omitted (or throwing) leaves
   * every row `unknown` — discovery still works, it just cannot promise
   * anything, which is the honest degradation.
   */
  probe?: (item: LocalCredentialItem) => Promise<CredentialProbe>
  now?: () => number
  id?: () => string
}) {
  const stash = new Map<string, {
    expiresAt: number
    org?: string
    items: Map<string, LocalCredentialItem>
  }>()
  const now = input.now ?? Date.now

  /**
   * A probe that throws is an unknown, never a broken: a DNS failure or an
   * offline laptop must not tell the user their credential is bad.
   */
  async function runProbe(item: LocalCredentialItem): Promise<CredentialProbe> {
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
      const maskKey = randomBytes(32)
      const connected = new Set((input.connected?.(org) ?? []).map(selectionKey))
      // Probe every candidate before offering it. Reading a token off disk says
      // nothing about whether the provider will accept it, and a credential that
      // is saved and then fails is worse than one that was never found — the
      // user believes setup succeeded. Probes run in parallel and are resolved
      // once per discovery, so the result is stashed rather than re-spent.
      const probes = await Promise.all(collected.map((item) => runProbe(item)))
      const items = new Map(collected.map((item) => {
        const redacted = preview(item, maskKey, connected)
        return [selectionKey(redacted), item]
      }))
      stash.set(discovery_id, { expiresAt: now() + ttl, org, items })
      const timer = setTimeout(() => stash.delete(discovery_id), ttl)
      timer.unref?.()
      return {
        discovery_id,
        items: collected.map((item, index) => preview(item, maskKey, connected, probes[index])),
      }
    },
    async save(request: { discovery_id: string; items: CredentialDiscoverySelection[] }, org?: string) {
      const discovery = stash.get(request.discovery_id)
      if (!discovery) throw new CredentialDiscoveryError("discovery_not_found")
      if (now() > discovery.expiresAt) throw new CredentialDiscoveryError("discovery_expired")
      if (org !== discovery.org) throw new CredentialDiscoveryError("discovery_org_mismatch")

      const keys = request.items.map(selectionKey)
      if (new Set(keys).size !== keys.length) throw new CredentialDiscoveryError("discovery_duplicate_item")
      const selected = keys.map((key) => discovery.items.get(key))
      if (selected.some((item) => !item)) throw new CredentialDiscoveryError("discovery_item_not_found")

      const credentials = await Promise.all(selected.map((item, index) => input.save({
        provider_id: item!.provider_id,
        kind: item!.kind,
        source: request.items[index]!.scope === "shared" ? "managed" : "local_only",
        label: item!.label,
        ...(item!.account_id ? { account_id: item!.account_id } : {}),
        secret: item!.secret,
        ...(item!.fresh_until ? { expires_at: item!.fresh_until } : {}),
        scope: request.items[index]!.scope,
        consent: { at: now(), surface: "desktop_discovery" },
      }, org)))
      stash.delete(request.discovery_id)

      return {
        saved: request.items.map((item, index) => ({
          credential_id: credentials[index]!.id,
          provider_id: item.provider_id,
          ...(item.account_id ? { account_id: item.account_id } : {}),
        })),
      }
    },
  }
}

export const credentialDiscovery = createCredentialDiscovery({
  // The one path a Keychain dialog may interrupt: `POST /discover` is reached
  // only from the setup step's "Find credentials on this computer" button, so
  // the user is already looking at the screen that asked. Every other consumer
  // of `collectLocalCredentials` leaves the flag off and reads
  // `~/.claude/.credentials.json` instead.
  collect: () => collectLocalCredentialItems({ allowKeychainPrompt: true }),
  save: putCredential,
  connected: listCredentials,
  probe: probeDiscoveredCredential,
})
