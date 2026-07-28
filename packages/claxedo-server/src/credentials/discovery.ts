import { createHmac, randomUUID } from "crypto"
import { collectLocalCredentialItems, type LocalCredentialItem } from "./sync"
import { listCredentials, putCredential } from "./registry"
import type { CredentialScope, CredentialWrite } from "./types"

const ttl = 5 * 60 * 1000

export type CredentialDiscoveryPreview = {
  provider_id: string
  kind: LocalCredentialItem["kind"]
  label: string
  account_id?: string
  origin: string
  fresh_until?: number
  already_connected?: boolean
}

export type CredentialDiscoverySelection = {
  provider_id: string
  account_id?: string
  scope: CredentialScope
}

export class CredentialDiscoveryError extends Error {
  constructor(
    public readonly code: "discovery_not_found" | "discovery_expired" | "discovery_item_not_found" | "discovery_duplicate_item",
  ) {
    super(code)
  }
}

function maskedAccountId(accountId: string, discoveryId: string) {
  return `account…${createHmac("sha256", discoveryId).update(accountId).digest("hex").slice(0, 10)}`
}

function preview(item: LocalCredentialItem, discoveryId: string, connected: Set<string>): CredentialDiscoveryPreview {
  return {
    provider_id: item.provider_id,
    kind: item.kind,
    label: item.label,
    ...(item.account_id ? { account_id: maskedAccountId(item.account_id, discoveryId) } : {}),
    origin: item.origin,
    ...(item.fresh_until ? { fresh_until: item.fresh_until } : {}),
    ...(connected.has(selectionKey(item)) ? { already_connected: true } : {}),
  }
}

function selectionKey(input: { provider_id: string; account_id?: string | null }) {
  return `${input.provider_id}\u0000${input.account_id ?? ""}`
}

export function createCredentialDiscovery(input: {
  collect: () => Promise<LocalCredentialItem[]>
  save: (item: CredentialWrite, org?: string) => Promise<{ id: string }>
  connected?: (org?: string) => Array<{ provider_id: string; account_id?: string | null }>
  now?: () => number
  id?: () => string
}) {
  const stash = new Map<string, { expiresAt: number; items: Map<string, LocalCredentialItem> }>()
  const now = input.now ?? Date.now

  return {
    async discover(org?: string) {
      const collected = await input.collect()
      const discovery_id = (input.id ?? randomUUID)()
      const connected = new Set((input.connected?.(org) ?? []).map(selectionKey))
      const items = new Map(collected.map((item) => {
        const redacted = preview(item, discovery_id, connected)
        return [selectionKey(redacted), item]
      }))
      stash.set(discovery_id, { expiresAt: now() + ttl, items })
      const timer = setTimeout(() => stash.delete(discovery_id), ttl)
      timer.unref?.()
      return { discovery_id, items: collected.map((item) => preview(item, discovery_id, connected)) }
    },
    async save(request: { discovery_id: string; items: CredentialDiscoverySelection[] }, org?: string) {
      const discovery = stash.get(request.discovery_id)
      if (!discovery) throw new CredentialDiscoveryError("discovery_not_found")
      if (now() > discovery.expiresAt) throw new CredentialDiscoveryError("discovery_expired")

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
  collect: collectLocalCredentialItems,
  save: putCredential,
  connected: listCredentials,
})
