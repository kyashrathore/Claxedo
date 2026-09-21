import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { bootstrapDirectory, type DirectoryBootstrapSdk } from "./bootstrap"
import type { NormalizedProviderListResponse } from "@/platform/query/provider-list"
import { requestUrl } from "@/lib/url"

/** Native provider catalogs belong to the control plane, including VM sessions. */

const CENTRAL = "https://central.test"
const RELAY = "https://relay.test"
const WS = "ws_relay1"

async function settleWarmup() {
  await vi.advanceTimersByTimeAsync(1)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  queryClient.clear()
  vi.clearAllTimers()
  vi.useRealTimers()
})

function connectionBody() {
  return {
    backing: "cloud-vm",
    sessionAuthority: "managed-private",
    workspaceId: WS,
    role: "owner",
    relayUrl: RELAY,
    runtimeAccessToken: "header.payload.sig",
    tokenExpiresAt: Date.now() + 30 * 60_000,
  }
}

function providerCatalog() {
  return {
    all: [{ id: "openai", name: "OpenAI", source: "api", models: { "model-1": { id: "model-1" } } }],
    connected: ["openai"],
    default: { openai: "model-1" },
  }
}

function fakeSdk(): DirectoryBootstrapSdk {
  return {
    project: { ensure: async () => ({ data: { id: "project", worktree: "/work/project", sandboxes: [], time: { created: 1, updated: 1 } } }) },
    path: { get: async () => ({ data: { home: "", state: "", config: "", worktree: "", directory: "" } }) },
    command: { list: async () => ({ data: [] }) },
    vcs: { get: async () => ({ data: {} }) },
  }
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
    if (url === `${CENTRAL}/api/claxedo/agent-config/providers?nativeHarness=pi`) {
      return Response.json(providerCatalog())
    }
    if (url.startsWith(`${CENTRAL}/api/claxedo/agent-config/agents?`) ||
      url === `${CENTRAL}/api/claxedo/agent-config/commands`) return Response.json([])
    return new Response("not found", { status: 404 })
  }) as typeof fetch
}

describe("bootstrapDirectory control-plane provider catalog", () => {
  test("signed workspace fetches the control-plane catalog without forwarding credentials to its relay", async () => {
    const calls: string[] = []
    await bootstrapDirectory({
      directory: `workspace:${WS}`,
      sdk: fakeSdk(),
      loadSessions: () => {},
      translate: (key) => key,
      fetch: trackingFetch(calls),
      baseUrl: CENTRAL,
      harnessType: "pi",
      quiet: true,
    })
    await settleWarmup()

    expect(calls.filter((url) => url.includes("agent-config/providers"))).toEqual([
      `${CENTRAL}/api/claxedo/agent-config/providers?nativeHarness=pi`,
    ])
    expect(calls.filter((url) => url.startsWith(`${RELAY}/`))).toEqual([`${RELAY}/workspaces/${WS}/vcs`])
    expect(calls.filter((url) => url.startsWith(`${CENTRAL}/provider`))).toEqual([])
    expect(calls.some((url) => new URL(url).pathname.endsWith("/config"))).toBe(false)

    // Workspace model choices remain isolated even though credentials are central.
    const providers = queryClient.getQueryData<NormalizedProviderListResponse>(
      queryKeys.controlPlane.providers(CENTRAL, `workspace:${WS}`, "pi"),
    )
    expect([...(providers?.all.keys() ?? [])]).toEqual(["openai"])
    expect(providers?.all.get("openai")?.source).toBe("api")
  })

  test("plain directories use the central provider route", async () => {
    const calls: string[] = []
    await bootstrapDirectory({
      directory: "/Users/someone/project",
      sdk: fakeSdk(),
      loadSessions: () => {},
      translate: (key) => key,
      fetch: trackingFetch(calls),
      baseUrl: CENTRAL,
      harnessType: "pi",
      quiet: true,
    })
    await settleWarmup()

    expect(calls.filter((url) => url.includes("agent-config/providers"))).toEqual([
      `${CENTRAL}/api/claxedo/agent-config/providers?nativeHarness=pi`,
    ])
    expect(calls.filter((url) => url.startsWith(`${RELAY}/`))).toEqual([])
    expect(calls).toContain(`${CENTRAL}/api/claxedo/agent-config/commands`)
    expect(queryClient.getQueryData(queryKeys.directory.project(CENTRAL, "/Users/someone/project"))).toBe("project")
    expect(calls.some((url) => new URL(url).pathname.endsWith("/config"))).toBe(false)
    expect(queryClient.getQueryCache().getAll().some((query) => query.queryKey[2] === "config")).toBe(false)
  })
})
