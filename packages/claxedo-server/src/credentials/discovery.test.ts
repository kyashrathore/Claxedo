import { describe, expect, test, vi } from "vitest"
import { createCredentialDiscovery } from "./discovery"
import type { LocalCredentialItem } from "./sync"
import type { CredentialWrite } from "./types"

const items: LocalCredentialItem[] = [
  {
    provider_id: "openai",
    kind: "oauth_token",
    source: "local_only",
    label: "Codex subscription",
    account_id: "account-one@example.com",
    origin: "~/.codex/accounts/account-one.auth.json",
    fresh_until: 500,
    secret: "first-secret",
  },
  {
    provider_id: "openai",
    kind: "oauth_token",
    source: "local_only",
    label: "Codex subscription",
    account_id: "account-two@example.com",
    origin: "~/.codex/accounts/account-two.auth.json",
    secret: "second-secret",
  },
  {
    provider_id: "anthropic",
    kind: "api_key",
    source: "env",
    label: "Anthropic API key",
    origin: "ANTHROPIC_API_KEY",
    secret: "third-secret",
  },
]

function setup(input?: { now?: () => number; collected?: LocalCredentialItem[] }) {
  const save = vi.fn(async (item: CredentialWrite) => ({ id: `saved-${item.account_id ?? item.provider_id}` }))
  const service = createCredentialDiscovery({
    collect: async () => input?.collected ?? items,
    save,
    now: input?.now ?? (() => 100),
    id: () => "discovery-id",
  })
  return { save, service }
}

describe("credential discovery", () => {
  test("returns a redacted preview and persists nothing during discovery", async () => {
    const { save, service } = setup()

    const result = await service.discover()

    expect(save).not.toHaveBeenCalled()
    expect(result.discovery_id).toBe("discovery-id")
    expect(result.items).toHaveLength(3)
    expect(result.items[0]).toMatchObject({
      provider_id: "openai",
      kind: "oauth_token",
      label: "Codex subscription",
      account_id: expect.stringMatching(/^account…[a-f0-9]{10}$/),
      origin: "~/.codex/accounts/account-one.auth.json",
      fresh_until: 500,
    })
    expect(JSON.stringify(result)).not.toContain("first-secret")
    expect(JSON.stringify(result)).not.toContain("account-one@example.com")
  })

  test("returns an explicit empty preview", async () => {
    const { service } = setup({ collected: [] })

    await expect(service.discover()).resolves.toEqual({ discovery_id: "discovery-id", items: [] })
  })

  test("saves exactly the selected account with explicit scope and consent", async () => {
    const { save, service } = setup()
    const discovery = await service.discover()

    const result = await service.save({
      discovery_id: discovery.discovery_id,
      items: [{
        provider_id: "openai",
        account_id: discovery.items[1]!.account_id,
        scope: "shared",
      }],
    })

    expect(result).toEqual({ saved: [{
      credential_id: "saved-account-two@example.com",
      provider_id: "openai",
      account_id: discovery.items[1]!.account_id,
    }] })
    expect(save).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      provider_id: "openai",
      account_id: "account-two@example.com",
      secret: "second-secret",
      scope: "shared",
      consent: { at: 100, surface: "desktop_discovery" },
    }))
    expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ secret: "first-secret" }))
  })

  test("supports selecting multiple accounts for the same provider independently", async () => {
    const { save, service } = setup()
    const discovery = await service.discover()

    await service.save({
      discovery_id: discovery.discovery_id,
      items: discovery.items.slice(0, 2).map((item) => ({
        provider_id: item.provider_id,
        account_id: item.account_id,
        scope: "local" as const,
      })),
    })

    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls.map(([item]) => item.account_id)).toEqual([
      "account-one@example.com",
      "account-two@example.com",
    ])
  })

  test("fails closed for unknown, stale, tampered, and replayed discoveries", async () => {
    let now = 100
    const { save, service } = setup({ now: () => now })
    const discovery = await service.discover()
    const selection = {
      discovery_id: discovery.discovery_id,
      items: [{ provider_id: "openai", account_id: discovery.items[0]!.account_id, scope: "local" as const }],
    }

    await expect(service.save({ ...selection, discovery_id: "unknown" })).rejects.toMatchObject({ code: "discovery_not_found" })
    await expect(service.save({
      ...selection,
      items: [{ provider_id: "openai", account_id: "account…tampered0000", scope: "local" }],
    })).rejects.toMatchObject({ code: "discovery_item_not_found" })
    expect(save).not.toHaveBeenCalled()

    const next = await service.discover()
    now = 100 + 5 * 60 * 1000 + 1
    await expect(service.save({
      discovery_id: next.discovery_id,
      items: [{ provider_id: "anthropic", scope: "local" }],
    })).rejects.toMatchObject({ code: "discovery_expired" })

    now = 100
    const singleUse = await service.discover()
    await service.save({
      discovery_id: singleUse.discovery_id,
      items: [{ provider_id: "anthropic", scope: "local" }],
    })
    await expect(service.save({
      discovery_id: singleUse.discovery_id,
      items: [{ provider_id: "anthropic", scope: "local" }],
    })).rejects.toMatchObject({ code: "discovery_not_found" })
  })
})
