import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { bootstrapDirectory, type DirectoryBootstrapSdk } from "./bootstrap"
import type { NormalizedProviderListResponse } from "@/platform/query/provider-list"

/**
 * Provider catalog routing for signed workspaces (hosted central).
 *
 * A hosted central (Cloudflare Worker) has no central harness and no
 * `/api/workspace/resolve`, so the boot provider fetch must reach the
 * workspace RUNTIME through the relay (`/workspaces/:id/provider`) whenever
 * the directory is a signed workspace ref — and only fall back to the
 * central `/provider` route for plain directories.
 */

const CENTRAL = "https://central.test"
const RELAY = "https://relay.test"
const WS = "ws_relay1"

afterEach(() => {
  queryClient.clear()
})

function requestUrl(input: string | URL | Request) {
  if (input instanceof Request) return input.url
  if (input instanceof URL) return input.href
  return String(input)
}

function connectionBody() {
  return {
    access: "cloud",
    backing: "cloud-vm",
    workspaceId: WS,
    role: "owner",
    relayUrl: RELAY,
    runtimeAccessToken: "header.payload.sig",
    tokenExpiresAt: Date.now() + 30 * 60_000,
  }
}

function providerCatalog() {
  return {
    all: [{ id: "opencode", name: "OpenCode", models: { "model-1": { id: "model-1" } } }],
    connected: ["opencode"],
    default: { opencode: "model-1" },
  }
}

function fakeSdk(): DirectoryBootstrapSdk {
  return {
    project: { current: async () => ({ data: { id: "project" } }) },
    provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
    app: { agents: async () => ({ data: [] }) },
    config: { get: async () => ({ data: {} }) },
    path: { get: async () => ({ data: { home: "", state: "", config: "", worktree: "", directory: "" } }) },
    command: { list: async () => ({ data: [] }) },
    vcs: { get: async () => ({ data: {} }) },
    // as-any: test double implements only the API surface exercised by this test.
  } as unknown as DirectoryBootstrapSdk
}

function trackingFetch(calls: string[]) {
  return (async (input: string | URL | Request) => {
    const url = requestUrl(input)
    calls.push(url)
    if (url.startsWith(`${CENTRAL}/api/workspace/resolve`)) {
      return new Response("not found", { status: 404 })
    }
    if (url === `${CENTRAL}/api/workspace/${WS}/connection`) {
      return Response.json(connectionBody())
    }
    if (url.startsWith(`${RELAY}/workspaces/${WS}/provider`)) {
      return Response.json(providerCatalog())
    }
    if (url.startsWith(`${CENTRAL}/provider`)) {
      return Response.json(providerCatalog())
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch
}

describe("bootstrapDirectory provider routing", () => {
  test("signed workspace ref fetches the provider catalog through the relay, not the central global route", async () => {
    const calls: string[] = []
    await bootstrapDirectory({
      directory: `workspace:${WS}`,
      sdk: fakeSdk(),
      loadSessions: () => {},
      translate: (key) => key,
      fetch: trackingFetch(calls),
      baseUrl: CENTRAL,
      quiet: true,
    })

    const relayProvider = calls.filter((url) => url.startsWith(`${RELAY}/workspaces/${WS}/provider`))
    expect(relayProvider.length).toBeGreaterThan(0)
    expect(relayProvider[0]).toContain("harness=opencode")
    // The central global /provider route (404 on hosted centrals) is never hit.
    expect(calls.filter((url) => url.startsWith(`${CENTRAL}/provider`))).toEqual([])

    const providers = queryClient.getQueryData<NormalizedProviderListResponse>(
      queryKeys.controlPlane.providers(CENTRAL),
    )
    expect([...(providers?.all.keys() ?? [])]).toEqual(["opencode"])
  })

  test("plain directories still fall back to the central provider route", async () => {
    const calls: string[] = []
    await bootstrapDirectory({
      directory: "/Users/someone/project",
      sdk: fakeSdk(),
      loadSessions: () => {},
      translate: (key) => key,
      fetch: trackingFetch(calls),
      baseUrl: CENTRAL,
      harnessType: "opencode",
      quiet: true,
    })

    expect(calls.filter((url) => url.startsWith(`${CENTRAL}/provider`)).length).toBeGreaterThan(0)
    expect(calls.filter((url) => url.startsWith(`${RELAY}/`))).toEqual([])
  })
})
