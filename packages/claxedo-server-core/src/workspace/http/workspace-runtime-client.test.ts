import { afterEach, describe, expect, test, vi } from "vitest"
import type { RelayProvider } from "../../adapters/relay-port"
import type { SandboxManagerPort } from "../../sandbox/manager-port"
import type { Workspace } from "../store/index"
import { createWorkspaceRuntimeClient } from "./workspace-runtime-client"

type FetchCall = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>

const workspace = {
  id: "ws-1",
  org_id: "org-1",
  kind: "cloud",
  directory: "/workspace",
  created_at: 1,
  updated_at: 1,
} as Workspace

function ready(hostId: string, homeRegion: string, epoch: number) {
  return {
    status: "ready" as const,
    workspaceId: workspace.id,
    sandboxId: `sandbox-${epoch}`,
    url: "https://runtime-manager.test",
    hostId,
    homeRegion,
    epoch,
  }
}

function relayProvider(tokenExpiry = Date.now() + 10 * 60_000): RelayProvider {
  return {
    getRelayEndpoint: vi.fn(async (_workspaceId: string, region: string) => `https://relay-${region}.example`),
    mintHostTunnelToken: vi.fn(async () => ({ token: "host-token", expiresAt: tokenExpiry, jti: "host-jti" })),
    mintRuntimeAccessToken: vi.fn(async ({ hostId }) => ({
      token: `token-${hostId}`,
      expiresAt: tokenExpiry,
      jti: `jti-${hostId}`,
    })),
    resolveTarget: vi.fn(async () => undefined),
    drainWorkspace: vi.fn(async () => {}),
  }
}

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : input.toString()
}

function installFetch(implementation: FetchCall) {
  const mock = Object.assign(vi.fn(implementation), {
    preconnect: globalThis.fetch.preconnect,
  })
  globalThis.fetch = mock
  return mock
}

function clientOptions(input?: { ensure?: ReturnType<typeof vi.fn>; tokenExpiry?: number }) {
  const ensure = input?.ensure ?? vi.fn(async () => ready("host-a", "us-east", 1))
  const relay = relayProvider(input?.tokenExpiry)
  const sandboxManager: SandboxManagerPort = {
    ensure,
    target: vi.fn(async () => ready("host-a", "us-east", 1)),
  }
  const client = createWorkspaceRuntimeClient({
    workspace,
    options: {
      sandboxManager,
      relayProvider: relay,
      runtimeActor: { principalKind: "service", actorId: "control-plane", actorKind: "agent" },
      role: "owner",
    },
  })
  return { client, ensure, relayProvider: relay }
}

describe("WorkspaceRuntimeClient", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.clearAllMocks()
  })

  test("shares one immutable generation across concurrent initial requests", async () => {
    let releaseEnsure!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseEnsure = resolve
    })
    const ensure = vi.fn(async () => {
      await gate
      return ready("host-a", "us-east", 4)
    })
    const { client, relayProvider } = clientOptions({ ensure })
    installFetch(async () => Response.json({ ok: true }))

    const requests = [client.request("/a"), client.request("/b"), client.request("/c")]
    releaseEnsure()
    await Promise.all(requests)

    expect(ensure).toHaveBeenCalledTimes(1)
    expect(relayProvider.getRelayEndpoint).toHaveBeenCalledTimes(1)
    expect(relayProvider.mintRuntimeAccessToken).toHaveBeenCalledTimes(1)
    expect(await client.resolveGeneration()).toEqual(
      expect.objectContaining({
        hostId: "host-a",
        homeRegion: "us-east",
        leaseEpoch: 4,
        relayUrl: "https://relay-us-east.example",
        accessToken: expect.objectContaining({ token: "token-host-a", hostId: "host-a" }),
      }),
    )
  })

  test("replaces host, relay, epoch, and token atomically after a safe-request failure", async () => {
    const ensure = vi
      .fn()
      .mockResolvedValueOnce(ready("host-a", "us-east", 1))
      .mockResolvedValueOnce(ready("host-b", "eu-west", 2))
    const { client } = clientOptions({ ensure })
    const seen: Array<{ url: string; authorization: string | null }> = []
    installFetch(async (url, init) => {
      seen.push({ url: requestUrl(url), authorization: new Headers(init?.headers).get("authorization") })
      return seen.length === 1 ? new Response("bad gateway", { status: 502 }) : Response.json({ ok: true })
    })

    await expect(client.request("/health")).resolves.toHaveProperty("status", 200)

    expect(seen).toEqual([
      { url: "https://relay-us-east.example/workspaces/ws-1/health", authorization: "Bearer token-host-a" },
      { url: "https://relay-eu-west.example/workspaces/ws-1/health", authorization: "Bearer token-host-b" },
    ])
    expect(await client.resolveGeneration()).toEqual(
      expect.objectContaining({
        hostId: "host-b",
        homeRegion: "eu-west",
        leaseEpoch: 2,
        relayUrl: "https://relay-eu-west.example",
        accessToken: expect.objectContaining({ token: "token-host-b", hostId: "host-b" }),
      }),
    )
  })

  test("keeps concurrent movement requests on complete old or new generations", async () => {
    const ensure = vi
      .fn()
      .mockResolvedValueOnce(ready("host-a", "us-east", 1))
      .mockResolvedValueOnce(ready("host-b", "eu-west", 2))
    let releaseHostB!: () => void
    let hostBMintStarted!: () => void
    const hostBGate = new Promise<void>((resolve) => {
      releaseHostB = resolve
    })
    const hostBStarted = new Promise<void>((resolve) => {
      hostBMintStarted = resolve
    })
    const relay = relayProvider()
    relay.mintRuntimeAccessToken = vi.fn(async ({ hostId }) => {
      if (hostId === "host-b") {
        hostBMintStarted()
        await hostBGate
      }
      return { token: `token-${hostId}`, expiresAt: Date.now() + 10 * 60_000, jti: `jti-${hostId}` }
    })
    const sandboxManager: SandboxManagerPort = {
      ensure,
      target: vi.fn(async () => ready("host-a", "us-east", 1)),
    }
    const client = createWorkspaceRuntimeClient({
      workspace,
      options: {
        sandboxManager,
        relayProvider: relay,
        runtimeActor: { principalKind: "service", actorId: "control-plane", actorKind: "agent" },
        role: "owner",
      },
    })
    const seen: Array<{ path: string; relay: string; authorization: string | null }> = []
    installFetch(async (url, init) => {
      const parsed = new URL(requestUrl(url))
      seen.push({
        path: parsed.pathname,
        relay: parsed.origin,
        authorization: new Headers(init?.headers).get("authorization"),
      })
      if (parsed.pathname.endsWith("/move") && parsed.origin.includes("us-east")) {
        return new Response("bad gateway", { status: 502 })
      }
      return Response.json({ ok: true })
    })
    await client.resolveGeneration()

    const moving = client.request("/move")
    await hostBStarted
    await client.request("/concurrent")
    releaseHostB()
    await moving
    await client.request("/after")

    expect(seen).toEqual([
      { path: "/workspaces/ws-1/move", relay: "https://relay-us-east.example", authorization: "Bearer token-host-a" },
      {
        path: "/workspaces/ws-1/concurrent",
        relay: "https://relay-us-east.example",
        authorization: "Bearer token-host-a",
      },
      { path: "/workspaces/ws-1/move", relay: "https://relay-eu-west.example", authorization: "Bearer token-host-b" },
      { path: "/workspaces/ws-1/after", relay: "https://relay-eu-west.example", authorization: "Bearer token-host-b" },
    ])
  })

  test("dispatches an exact generation without resolving another target", async () => {
    const { client, ensure } = clientOptions()
    installFetch(async () => Response.json({ ok: true }))
    const generation = await client.resolveGeneration()
    if (!generation) throw new Error("expected a cloud runtime generation")

    await client.requestGeneration(generation, "/worktrees", { method: "POST" })

    expect(ensure).toHaveBeenCalledTimes(1)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  test("never retries a state-changing request", async () => {
    const ensure = vi
      .fn()
      .mockResolvedValueOnce(ready("host-a", "us-east", 1))
      .mockResolvedValueOnce(ready("host-b", "eu-west", 2))
    const { client } = clientOptions({ ensure })
    installFetch(async () => new Response("bad gateway", { status: 502 }))

    await expect(client.request("/exec", { method: "POST" })).resolves.toHaveProperty("status", 502)

    expect(ensure).toHaveBeenCalledTimes(1)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})
