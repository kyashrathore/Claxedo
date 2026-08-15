import { describe, expect, test } from "bun:test"
import {
  createComposerClient,
  decodeCredentialProviders,
  decodeHarnessOptions,
  decodeModelVariants,
  decodePermissionModes,
  decodeProviderCatalog,
  decodeWorkspaces,
  HARNESS_ROSTER,
} from "./composer-client"

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function client(fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  return createComposerClient({ baseUrl: "http://127.0.0.1:1707", fetcher })
}

describe("listHarnesses", () => {
  test("returns the full roster with the server's active harness flagged", async () => {
    const c = client(async (url) => {
      expect(url).toBe("http://127.0.0.1:1707/api/claxedo/agent-config/harness?directory=%2Ftmp%2Fp")
      // Real shape verified against the live server 2026-08-15.
      return response({ harness: { id: "opencode", access: "native" }, activeType: "claude-acp", status: "ready" })
    })
    const roster = await c.listHarnesses("/tmp/p")
    expect(roster.map((h) => h.id)).toEqual(HARNESS_ROSTER.map((h) => h.id))
    expect(roster.find((h) => h.id === "claude-acp")?.active).toBe(true)
    expect(roster.find((h) => h.id === "opencode")?.active).toBeUndefined()
  })

  test("still returns the roster when the route is missing or broken", async () => {
    const c = client(async () => new Response("nope", { status: 404 }))
    const roster = await c.listHarnesses()
    expect(roster).toHaveLength(HARNESS_ROSTER.length)
    expect(roster.every((h) => !h.active)).toBe(true)
  })
})

describe("harnessOptions", () => {
  test("extracts models and thought levels from ACP-shaped options (value/name)", async () => {
    const c = client(async (url) => {
      expect(url).toBe(
        "http://127.0.0.1:1707/api/claxedo/agent-config/harness/options?directory=%2Ftmp%2Fp&harness=claude-acp",
      )
      return response({
        options: [
          {
            id: "model", name: "Model", category: "model", type: "select",
            currentValue: "opus",
            options: [
              { value: "opus", name: "Opus", description: "Opus 4.8 with 1M context" },
              { value: "sonnet", name: "Sonnet" },
            ],
          },
          {
            id: "effort", name: "Effort", category: "thought_level", type: "select",
            currentValue: "default",
            options: [{ value: "default", name: "Default" }, { value: "high", name: "High" }],
          },
          { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "x", options: [] },
        ],
        source: "harness",
        stale: false,
      })
    })
    const result = await c.harnessOptions({ directory: "/tmp/p", harness: "claude-acp" })
    expect(result.models).toEqual([
      { providerID: "claude-acp", modelID: "opus", name: "Opus", description: "Opus 4.8 with 1M context" },
      { providerID: "claude-acp", modelID: "sonnet", name: "Sonnet" },
    ])
    expect(result.efforts).toEqual([{ id: "default", name: "Default" }, { id: "high", name: "High" }])
    expect(result.source).toBe("harness")
    expect(result.stale).toBe(false)
  })

  test("accepts native-SDK selectOptions (id/name) too", () => {
    const result = decodeHarnessOptions({
      options: [{
        category: "model", type: "select", currentValue: "m1",
        selectOptions: [{ id: "m1", name: "Model One" }, { junk: true }],
      }],
      source: "catalog",
      stale: true,
    }, "claude-sdk")
    expect(result.models).toEqual([{ providerID: "claude-sdk", modelID: "m1", name: "Model One" }])
    expect(result.stale).toBe(true)
  })

  test("degrades an error body to empty options with the message kept", async () => {
    // Real answer from the live server for an unstartable harness.
    const c = client(async () => response(
      { error: { code: "harness_config_options_unavailable", message: "ACP newSession timed out after 10000ms" } },
      502,
    ))
    const result = await c.harnessOptions({ directory: "/tmp/p", harness: "claude-acp" })
    expect(result).toEqual({
      models: [],
      efforts: [],
      source: "empty",
      stale: true,
      error: "ACP newSession timed out after 10000ms",
    })
  })
})

describe("providerCatalog", () => {
  test("decodes providers, models, connected and defaults; drops deprecated models and junk", async () => {
    const c = client(async (url) => {
      expect(url).toBe("http://127.0.0.1:1707/provider?directory=%2Ftmp%2Fp&harness=opencode")
      return response({
        all: [
          {
            id: "anthropic",
            name: "Anthropic",
            models: {
              "claude-opus-4-8": { id: "claude-opus-4-8", name: "Claude Opus 4.8", status: "active" },
              "old-model": { id: "old-model", name: "Old", status: "deprecated" },
            },
          },
          { id: "empty", name: "Empty", models: {} },
          { nope: true },
        ],
        connected: ["anthropic", 42],
        default: { anthropic: "claude-opus-4-8", junk: 1 },
      })
    })
    const catalog = await c.providerCatalog({ directory: "/tmp/p", harness: "opencode" })
    expect(catalog.providers).toEqual([
      {
        id: "anthropic",
        name: "Anthropic",
        models: [{ providerID: "anthropic", modelID: "claude-opus-4-8", name: "Claude Opus 4.8" }],
      },
      { id: "empty", name: "Empty", models: [] },
    ])
    expect(catalog.connected).toEqual(["anthropic"])
    expect(catalog.defaults).toEqual({ anthropic: "claude-opus-4-8" })
  })

  test("surfaces the provider_models_unavailable error body as an empty catalog", async () => {
    const c = client(async () => response(
      { ok: false, error: { code: "provider_models_unavailable", message: "engine down" } },
      502,
    ))
    const catalog = await c.providerCatalog({ harness: "opencode" })
    expect(catalog).toEqual({ providers: [], connected: [], defaults: {}, error: "engine down" })
  })

  test("decodeModelVariants lifts a detail row's variants as effort options", () => {
    const body = {
      all: [{
        id: "anthropic",
        models: {
          "claude-opus-4-7": {
            variants: { low: { effort: "low" }, high: { effort: "high" }, max: { effort: "max" } },
          },
        },
      }],
    }
    expect(decodeModelVariants(body, "anthropic", "claude-opus-4-7")).toEqual([
      { id: "low", name: "low" },
      { id: "high", name: "high" },
      { id: "max", name: "max" },
    ])
    expect(decodeModelVariants(body, "anthropic", "missing")).toEqual([])
  })
})

describe("permissionModes", () => {
  test("draft (no session) reads /permission/modes with directory and harness", async () => {
    const c = client(async (url) => {
      expect(url).toBe("http://127.0.0.1:1707/permission/modes?directory=%2Ftmp%2Fp&harness=claude-acp")
      // Trimmed from the live server's real claude-acp answer.
      return response({
        modes: [
          { id: "default", name: "Manual", description: "Standard behavior", level: "ask" },
          { id: "acceptEdits", name: "Accept Edits" },
        ],
        appliesFrom: "next-turn",
      })
    })
    const result = await c.permissionModes({ directory: "/tmp/p", harness: "claude-acp" })
    expect(result.modes).toEqual([
      { id: "default", name: "Manual", description: "Standard behavior", level: "ask" },
      { id: "acceptEdits", name: "Accept Edits" },
    ])
    expect(result.unsupported).toBeUndefined()
  })

  test("an existing session reads its own permission-mode route", async () => {
    const c = client(async (url) => {
      expect(url).toBe("http://127.0.0.1:1707/session/ses%201/permission-mode?directory=%2Ftmp%2Fp")
      return response({ modes: [{ id: "auto", name: "Auto" }], currentModeId: "auto" })
    })
    const result = await c.permissionModes({ directory: "/tmp/p", sessionId: "ses 1" })
    expect(result.currentModeId).toBe("auto")
  })

  test("keeps the unsupported marker for harnesses without a mode surface", () => {
    const result = decodePermissionModes({
      modes: [],
      unsupported: "opencode has no permission modes of its own",
      appliesFrom: "next-turn",
    })
    expect(result.modes).toEqual([])
    expect(result.unsupported).toBe("opencode has no permission modes of its own")
  })
})

describe("workspaces", () => {
  test("decodes cloud and local workspaces with access kind, dropping junk", async () => {
    const c = client(async (url) => {
      expect(url).toBe("http://127.0.0.1:1707/api/claxedo/workspace")
      return response({
        workspaces: [
          {
            workspaceId: "ws1", projectId: "ws1", directory: "/tmp/p",
            workspaceName: null, access: "local", git: { repo: "p", branch: "main", remote: null },
          },
          { workspaceId: "ws2", directory: "/workspace", workspaceName: "Cloudy", access: "cloud", git: {} },
          { directory: "/no-id" },
          "junk",
        ],
      })
    })
    expect(await c.listWorkspaces()).toEqual([
      { workspaceId: "ws1", directory: "/tmp/p", access: "local", branch: "main" },
      { workspaceId: "ws2", directory: "/workspace", access: "cloud", name: "Cloudy" },
    ])
  })

  test("decodeWorkspaces tolerates a shapeless body", () => {
    expect(decodeWorkspaces(undefined)).toEqual([])
    expect(decodeWorkspaces({ workspaces: "nope" })).toEqual([])
  })
})

describe("worktrees", () => {
  test("lists worktree directories", async () => {
    const c = client(async (url) => {
      expect(url).toBe("http://127.0.0.1:1707/experimental/worktree?directory=%2Ftmp%2Fp")
      return response(["/data/worktree/proj/wt-1", 7, "/data/worktree/proj/wt-2"])
    })
    expect(await c.listWorktrees("/tmp/p")).toEqual(["/data/worktree/proj/wt-1", "/data/worktree/proj/wt-2"])
  })

  test("creates a worktree and returns {name, branch, directory}", async () => {
    let sent: { url: string; body: unknown } | undefined
    const c = client(async (url, init) => {
      sent = { url, body: JSON.parse(String(init?.body)) }
      return response({ name: "probe", branch: "opencode/probe", directory: "/data/worktree/proj/probe" })
    })
    const worktree = await c.createWorktree({ directory: "/tmp/p", name: "probe" })
    expect(sent?.url).toBe("http://127.0.0.1:1707/experimental/worktree?directory=%2Ftmp%2Fp")
    expect(sent?.body).toEqual({ name: "probe" })
    expect(worktree).toEqual({ name: "probe", branch: "opencode/probe", directory: "/data/worktree/proj/probe" })
  })

  test("a create refused by the server throws with its message", async () => {
    const c = client(async () => response(
      { error: { code: "opencode_worktree_create_failed", message: "no commits yet" } },
    ))
    await expect(c.createWorktree({ directory: "/tmp/p" })).rejects.toThrow(/no commits yet/)
  })
})

describe("credentials", () => {
  test("lists credential providers with their auth methods", async () => {
    const c = client(async (url) => {
      expect(url).toBe("http://127.0.0.1:1707/provider/auth?harness=claude-acp")
      return response({
        "claude-acp": [{ type: "api", label: "API Key" }],
        "codex-acp": [
          { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
          { type: "api", label: "API Key" },
        ],
        junk: "not-an-array",
      })
    })
    expect(await c.listCredentialProviders("claude-acp")).toEqual([
      { id: "claude-acp", methods: [{ type: "api", label: "API Key" }] },
      { id: "codex-acp", methods: [
        { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
        { type: "api", label: "API Key" },
      ] },
    ])
  })

  test("decodeCredentialProviders tolerates junk methods", () => {
    expect(decodeCredentialProviders({ p: [{ type: "carrier-pigeon", label: "?" }, { type: "api", label: "Key" }] }))
      .toEqual([{ id: "p", methods: [{ type: "api", label: "Key" }] }])
  })

  test("puts an API key as a managed api_key credential", async () => {
    let sent: { url: string; method?: string | undefined; body: unknown } | undefined
    const c = client(async (url, init) => {
      sent = { url, method: init?.method, body: JSON.parse(String(init?.body)) }
      return response({
        credential: { id: "cred_1", provider_id: "claude-acp", kind: "api_key", status: "available", has_secret: true },
      })
    })
    const stored = await c.putCredential({ providerId: "claude-acp", apiKey: "sk-test" })
    expect(sent?.url).toBe("http://127.0.0.1:1707/api/claxedo/credentials")
    expect(sent?.method).toBe("PUT")
    expect(sent?.body).toEqual({ provider_id: "claude-acp", kind: "api_key", secret: "sk-test" })
    expect(stored).toEqual({ id: "cred_1", providerId: "claude-acp", kind: "api_key", status: "available" })
  })
})

describe("decoders reject shapeless bodies without throwing", () => {
  test("provider catalog", () => {
    expect(decodeProviderCatalog(null)).toEqual({ providers: [], connected: [], defaults: {} })
  })
  test("harness options", () => {
    expect(decodeHarnessOptions([], "x")).toEqual({ models: [], efforts: [], source: "empty", stale: false })
  })
  test("permission modes", () => {
    expect(decodePermissionModes("junk")).toEqual({ modes: [] })
  })
})
