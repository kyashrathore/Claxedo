import { describe, expect, test, vi } from "vitest"
import { createCredentialDiscovery, type CredentialDiscoveryProbe } from "./discovery"
import type { LocalCredentialItem } from "./sync"
import type { CredentialHealth, CredentialWrite } from "@claxedo/server-core/credentials/types"

// One provider handed to us twice in different shapes, which is what
// `collectLocalCredentials` produces for a machine holding both a subscription
// token in the environment and a pasted key in the agent config.
const items: LocalCredentialItem[] = [
  {
    provider_id: "claude-sdk",
    kind: "oauth_token",
    source: "env",
    label: "Synced from CLAUDE_CODE_OAUTH_TOKEN",
    origin: "Environment variable CLAUDE_CODE_OAUTH_TOKEN",
    secret: "first-secret",
  },
  {
    provider_id: "claude-sdk",
    kind: "api_key",
    source: "local_only",
    label: "Synced from local config",
    origin: "Claxedo local config",
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
  connected?: Array<{ provider_id: string; kind: LocalCredentialItem["kind"] }>
  probe?: (item: LocalCredentialItem) => Promise<CredentialDiscoveryProbe>
}) {
  const save = vi.fn(async (item: CredentialWrite) => ({ id: `saved-${item.provider_id}-${item.kind}` }))
  const recorded: Array<{ id: string; health: CredentialHealth; validatedAt: number }> = []
  const service = createCredentialDiscovery({
    collect: async () => input?.collected ?? items,
    save,
    ...(input?.connected ? { connected: () => input.connected! } : {}),
    recordHealth: (id, health, validatedAt) => void recorded.push({ id, health, validatedAt }),
    ...(input?.probe ? { probe: input.probe } : {}),
    now: input?.now ?? (() => 100),
    id: () => "discovery-id",
  })
  return { save, service, recorded }
}

describe("credential discovery", () => {
  test("returns a redacted preview and persists nothing during discovery", async () => {
    const { save, service } = setup()

    const result = await service.discover()

    expect(save).not.toHaveBeenCalled()
    expect(result.discovery_id).toBe("discovery-id")
    expect(result.items).toHaveLength(3)
    expect(result.items[0]).toMatchObject({
      provider_id: "claude-sdk",
      kind: "oauth_token",
      label: "Synced from CLAUDE_CODE_OAUTH_TOKEN",
      origin: "Environment variable CLAUDE_CODE_OAUTH_TOKEN",
    })
    expect(JSON.stringify(result)).not.toContain("first-secret")
  })

  test("returns an explicit empty preview", async () => {
    const { service } = setup({ collected: [] })

    await expect(service.discover()).resolves.toEqual({ discovery_id: "discovery-id", items: [] })
  })

  test("marks a candidate already connected when the store holds that provider in that shape", async () => {
    const { service } = setup({ connected: [{ provider_id: "claude-sdk", kind: "api_key" }] })

    const result = await service.discover()

    expect(result.items.map((item) => [item.provider_id, item.kind, item.already_connected === true])).toEqual([
      ["claude-sdk", "oauth_token", false],
      ["claude-sdk", "api_key", true],
      ["anthropic", "api_key", false],
    ])
  })

  test("saves exactly the selected candidate with explicit scope and consent", async () => {
    const { save, service } = setup()
    const discovery = await service.discover()

    const result = await service.save({
      discovery_id: discovery.discovery_id,
      items: [{ provider_id: "claude-sdk", kind: "api_key", scope: "shared" }],
    })

    expect(result).toEqual({ saved: [{
      credential_id: "saved-claude-sdk-api_key",
      provider_id: "claude-sdk",
      kind: "api_key",
    }] })
    expect(save).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      provider_id: "claude-sdk",
      kind: "api_key",
      secret: "second-secret",
      scope: "shared",
      consent: { at: 100, surface: "desktop_discovery" },
    }), undefined)
    expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ secret: "first-secret" }), undefined)
  })

  test("two candidates for one provider stay distinct, so a selection saves the secret it named", async () => {
    // Keyed by provider alone the two collide in the stash, and picking the
    // pasted key silently stores the environment's subscription token instead.
    const { save, service } = setup()
    const discovery = await service.discover()

    await service.save({
      discovery_id: discovery.discovery_id,
      items: [{ provider_id: "claude-sdk", kind: "oauth_token", scope: "local" }],
    })

    expect(save.mock.calls.map(([item]) => [item.kind, item.secret])).toEqual([["oauth_token", "first-secret"]])
  })

  test("forwards the caller's org so a discovered credential lands in the right tenant", async () => {
    const { save, service } = setup()
    const discovery = await service.discover("org_a")

    await service.save({
      discovery_id: discovery.discovery_id,
      items: [{ provider_id: "claude-sdk", kind: "oauth_token", scope: "local" }],
    }, "org_a")

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ provider_id: "claude-sdk" }), "org_a")
  })

  test("cannot save a discovery into a different organization", async () => {
    const { save, service } = setup()
    const discovery = await service.discover("org_a")

    await expect(service.save({
      discovery_id: discovery.discovery_id,
      items: [{ provider_id: "claude-sdk", kind: "oauth_token", scope: "local" }],
    }, "org_b")).rejects.toMatchObject({ code: "discovery_org_mismatch" })
    expect(save).not.toHaveBeenCalled()
  })

  test("supports selecting several candidates independently", async () => {
    const { save, service } = setup()
    const discovery = await service.discover()

    await service.save({
      discovery_id: discovery.discovery_id,
      items: discovery.items.slice(0, 2).map((item) => ({
        provider_id: item.provider_id,
        kind: item.kind,
        scope: "local" as const,
      })),
    })

    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls.map(([item]) => item.secret)).toEqual(["first-secret", "second-secret"])
  })

  test("refuses the same candidate named twice in one save", async () => {
    const { save, service } = setup()
    const discovery = await service.discover()

    await expect(service.save({
      discovery_id: discovery.discovery_id,
      items: [
        { provider_id: "anthropic", kind: "api_key", scope: "local" },
        { provider_id: "anthropic", kind: "api_key", scope: "shared" },
      ],
    })).rejects.toMatchObject({ code: "discovery_duplicate_item" })
    expect(save).not.toHaveBeenCalled()
  })

  test("fails closed for unknown, unoffered, stale, and replayed discoveries", async () => {
    let now = 100
    const { save, service } = setup({ now: () => now })
    const discovery = await service.discover()
    const selection = {
      discovery_id: discovery.discovery_id,
      items: [{ provider_id: "claude-sdk", kind: "oauth_token" as const, scope: "local" as const }],
    }

    await expect(service.save({ ...selection, discovery_id: "unknown" })).rejects.toMatchObject({ code: "discovery_not_found" })
    await expect(service.save({
      ...selection,
      items: [{ provider_id: "anthropic", kind: "oauth_token", scope: "local" }],
    })).rejects.toMatchObject({ code: "discovery_item_not_found" })
    expect(save).not.toHaveBeenCalled()

    const next = await service.discover()
    now = 100 + 5 * 60 * 1000 + 1
    await expect(service.save({
      discovery_id: next.discovery_id,
      items: [{ provider_id: "anthropic", kind: "api_key", scope: "local" }],
    })).rejects.toMatchObject({ code: "discovery_expired" })

    now = 100
    const singleUse = await service.discover()
    await service.save({
      discovery_id: singleUse.discovery_id,
      items: [{ provider_id: "anthropic", kind: "api_key", scope: "local" }],
    })
    await expect(service.save({
      discovery_id: singleUse.discovery_id,
      items: [{ provider_id: "anthropic", kind: "api_key", scope: "local" }],
    })).rejects.toMatchObject({ code: "discovery_not_found" })
  })
})

describe("live probing during discovery", () => {
  test("carries each candidate's verdict into its preview row", async () => {
    // Reading a token off disk says nothing about whether the provider will
    // accept it. Without this the user commits first and finds out later.
    const { service } = setup({
      probe: async (item) => item.secret === "second-secret"
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
    const probe = vi.fn(async (): Promise<CredentialDiscoveryProbe> => ({ state: "working" }))
    const { service } = setup({ probe })

    await service.discover()

    expect(probe).toHaveBeenCalledTimes(3)
  })

  test("a probe that throws is unknown, never broken", async () => {
    // An offline laptop must not tell the user their credential is bad.
    const { service } = setup({ probe: async () => { throw new Error("getaddrinfo ENOTFOUND") } })

    const result = await service.discover()

    expect(result.items.every((item) => item.probe?.state === "unknown")).toBe(true)
    expect(result.items[0].probe).toMatchObject({ reason: expect.stringContaining("ENOTFOUND") })
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

  test("saving writes the verdict the probe already reached instead of asking again", async () => {
    // The Codex probe spends real subscription quota. A row saved right after
    // being probed must not read as unchecked, and must not cost a second ask.
    const { service, recorded } = setup({ probe: async () => ({ state: "working", health: "ok" }) })
    const discovery = await service.discover()

    await service.save({
      discovery_id: discovery.discovery_id,
      items: [{ provider_id: "anthropic", kind: "api_key", scope: "local" }],
    })

    expect(recorded).toEqual([{ id: "saved-anthropic-api_key", health: "ok", validatedAt: 100 }])
  })

  test("a verdict the probe could not reach writes no health at all", async () => {
    const { service, recorded } = setup({ probe: async () => ({ state: "unknown", reason: "offline" }) })
    const discovery = await service.discover()

    await service.save({
      discovery_id: discovery.discovery_id,
      items: [{ provider_id: "anthropic", kind: "api_key", scope: "local" }],
    })

    expect(recorded).toEqual([])
  })

  test("a broken candidate can still be saved when the user overrides", async () => {
    // The verdict informs the default; it does not veto the user's choice.
    const { save, service } = setup({
      probe: async () => ({ state: "broken", reason: "The provider rejected this credential." }),
    })
    const discovery = await service.discover()

    await service.save({
      discovery_id: discovery.discovery_id,
      items: [{ provider_id: "anthropic", kind: "api_key", scope: "local" }],
    })

    expect(save).toHaveBeenCalledTimes(1)
  })
})
