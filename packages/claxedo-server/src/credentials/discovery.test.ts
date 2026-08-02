import { describe, expect, test, vi } from "vitest"
import { createCredentialDiscovery, type CredentialProbe } from "./discovery"
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

function setup(input?: {
  now?: () => number
  collected?: LocalCredentialItem[]
  probe?: (item: LocalCredentialItem) => Promise<CredentialProbe>
}) {
  const save = vi.fn(async (item: CredentialWrite) => ({ id: `saved-${item.account_id ?? item.provider_id}` }))
  const service = createCredentialDiscovery({
    collect: async () => input?.collected ?? items,
    save,
    ...(input?.probe ? { probe: input.probe } : {}),
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
    }), undefined)
    expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ secret: "first-secret" }), undefined)
  })

  test("forwards the caller's org so a discovered credential lands in the right tenant", async () => {
    const { save, service } = setup()
    const discovery = await service.discover("org_a")

    await service.save({
      discovery_id: discovery.discovery_id,
      items: [{ provider_id: "openai", account_id: discovery.items[1]!.account_id, scope: "local" }],
    }, "org_a")

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ provider_id: "openai" }), "org_a")
  })

  test("cannot save a discovery into a different organization", async () => {
    const { save, service } = setup()
    const discovery = await service.discover("org_a")

    await expect(service.save({
      discovery_id: discovery.discovery_id,
      items: [{ provider_id: "openai", account_id: discovery.items[1]!.account_id, scope: "local" }],
    }, "org_b")).rejects.toMatchObject({ code: "discovery_org_mismatch" })
    expect(save).not.toHaveBeenCalled()
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

describe("live probing during discovery", () => {
  test("carries each candidate's verdict into its preview row", async () => {
    // Reading a token off disk says nothing about whether the provider will
    // accept it. Without this the user commits first and finds out later.
    const { service } = setup({
      probe: async (item) => item.account_id === "account-two@example.com"
        ? { state: "broken", reason: "The provider rejected this credential." }
        : { state: "working" },
    })

    const result = await service.discover()

    expect(result.items.map((item) => item.probe)).toEqual([
      { state: "working" },
      { state: "broken", reason: "The provider rejected this credential." },
      { state: "working" },
    ])
  })

  test("probes every candidate exactly once per scan", async () => {
    // The Codex probe spends real subscription quota, so a scan must not
    // re-spend it per row or per re-render.
    const probe = vi.fn(async (): Promise<CredentialProbe> => ({ state: "working" }))
    const { service } = setup({ probe })

    await service.discover()

    expect(probe).toHaveBeenCalledTimes(3)
  })

  test("a probe that throws is unknown, never broken", async () => {
    // An offline laptop must not tell the user their credential is bad.
    const { service } = setup({ probe: async () => { throw new Error("getaddrinfo ENOTFOUND") } })

    const result = await service.discover()

    expect(result.items.every((item) => item.probe?.state === "unknown")).toBe(true)
    expect(result.items[0]!.probe).toMatchObject({ reason: expect.stringContaining("ENOTFOUND") })
  })

  test("no probe configured leaves every row unknown rather than claiming success", async () => {
    const { service } = setup()

    const result = await service.discover()

    expect(result.items.every((item) => item.probe?.state === "unknown")).toBe(true)
  })

  test("probing never persists anything", async () => {
    const { save, service } = setup({ probe: async () => ({ state: "working" }) })

    await service.discover()

    expect(save).not.toHaveBeenCalled()
  })

  test("a broken candidate can still be saved when the user overrides", async () => {
    // The verdict informs the default; it does not veto the user's choice.
    const { save, service } = setup({
      probe: async () => ({ state: "broken", reason: "The provider rejected this credential." }),
    })
    const discovery = await service.discover()

    await service.save({
      discovery_id: discovery.discovery_id,
      items: [{ provider_id: "anthropic", scope: "local" }],
    })

    expect(save).toHaveBeenCalledTimes(1)
  })
})
