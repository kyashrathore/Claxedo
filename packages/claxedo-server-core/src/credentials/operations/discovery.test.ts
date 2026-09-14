import { afterAll, describe, expect, test, vi } from "vitest"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { createCredentialDiscovery, type CredentialDiscoveryProbe } from "./discovery"
import { collectLocalCredentialItems, type LocalCredentialItem } from "./sync"
import type { CredentialHealth, CredentialWrite } from "@claxedo/server-core/credentials/types"

// The candidates come from the real collector, run against an environment
// holding one provider in two shapes — a Claude subscription token beside an
// Anthropic API key — plus a second provider. Every other variable the
// collector reads is blanked so the host machine's own keys cannot leak in,
// and the data dir points at nothing so no user config on this machine does.
vi.stubEnv("CLAXEDO_DATA_DIR", path.join(os.tmpdir(), `credential-discovery-${randomUUID().slice(0, 8)}`))
for (const name of [
  "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "DAYTONA_API_KEY", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET",
  "VERCEL_TOKEN", "VERCEL_OIDC_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID",
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_SANDBOX_WORKER_URL",
]) vi.stubEnv(name, "")
vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "first-secret")
vi.stubEnv("ANTHROPIC_API_KEY", "second-secret")
vi.stubEnv("CURSOR_API_KEY", "third-secret")
const items = await collectLocalCredentialItems()
afterAll(() => vi.unstubAllEnvs())

test("the collector hands discovery one provider in two shapes and a second provider", () => {
  expect(items).toEqual([
    {
      provider_id: "claude-sdk",
      kind: "oauth_token",
      source: "env",
      label: "Synced from CLAUDE_CODE_OAUTH_TOKEN",
      origin: "Environment variable CLAUDE_CODE_OAUTH_TOKEN",
      secret: JSON.stringify({ type: "claude_code_oauth", claudeAiOauth: { accessToken: "first-secret" } }),
    },
    {
      provider_id: "claude-sdk",
      kind: "api_key",
      source: "env",
      label: "Synced from ANTHROPIC_API_KEY",
      origin: "ANTHROPIC_API_KEY",
      secret: "second-secret",
    },
    {
      provider_id: "cursor-sdk",
      kind: "api_key",
      source: "env",
      label: "Synced from CURSOR_API_KEY",
      origin: "CURSOR_API_KEY",
      secret: "third-secret",
    },
  ])
})

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
      ["cursor-sdk", "api_key", false],
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
    expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ secret: items[0].secret }), undefined)
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

    expect(save.mock.calls.map(([item]) => [item.kind, item.secret])).toEqual([["oauth_token", items[0].secret]])
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
    expect(save.mock.calls.map(([item]) => item.secret)).toEqual([items[0].secret, items[1].secret])
  })

  test("refuses the same candidate named twice in one save", async () => {
    const { save, service } = setup()
    const discovery = await service.discover()

    await expect(service.save({
      discovery_id: discovery.discovery_id,
      items: [
        { provider_id: "cursor-sdk", kind: "api_key", scope: "local" },
        { provider_id: "cursor-sdk", kind: "api_key", scope: "shared" },
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
      items: [{ provider_id: "cursor-sdk", kind: "oauth_token", scope: "local" }],
    })).rejects.toMatchObject({ code: "discovery_item_not_found" })
    expect(save).not.toHaveBeenCalled()

    const next = await service.discover()
    now = 100 + 5 * 60 * 1000 + 1
    await expect(service.save({
      discovery_id: next.discovery_id,
      items: [{ provider_id: "cursor-sdk", kind: "api_key", scope: "local" }],
    })).rejects.toMatchObject({ code: "discovery_expired" })

    now = 100
    const singleUse = await service.discover()
    await service.save({
      discovery_id: singleUse.discovery_id,
      items: [{ provider_id: "cursor-sdk", kind: "api_key", scope: "local" }],
    })
    await expect(service.save({
      discovery_id: singleUse.discovery_id,
      items: [{ provider_id: "cursor-sdk", kind: "api_key", scope: "local" }],
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
      items: [{ provider_id: "cursor-sdk", kind: "api_key", scope: "local" }],
    })

    expect(recorded).toEqual([{ id: "saved-cursor-sdk-api_key", health: "ok", validatedAt: 100 }])
  })

  test("a verdict the probe could not reach writes no health at all", async () => {
    const { service, recorded } = setup({ probe: async () => ({ state: "unknown", reason: "offline" }) })
    const discovery = await service.discover()

    await service.save({
      discovery_id: discovery.discovery_id,
      items: [{ provider_id: "cursor-sdk", kind: "api_key", scope: "local" }],
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
      items: [{ provider_id: "cursor-sdk", kind: "api_key", scope: "local" }],
    })

    expect(save).toHaveBeenCalledTimes(1)
  })
})
