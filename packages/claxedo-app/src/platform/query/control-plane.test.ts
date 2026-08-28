import { describe, expect, test } from "bun:test"
import type { Model, Project, Provider, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import {
  normalizeProjectList,
  projectCatalogMissingWorkspace,
  projectListQuery,
  providerAuthQuery,
  providerCacheHarness,
  providerDetailsQuery,
  providerListQuery,
} from "./control-plane"
import { mergeProviderIndexWithDetails, normalizeProviderList } from "./provider-list"

/**
 * A REAL `Provider`, not a type assertion.
 *
 * These fixtures used to be object literals forced past `ProviderListResponse`,
 * which asserted on a shape the wire can never produce: `Provider` requires
 * `source`, `options` and complete `Model` values, while `normalizeProviderList`
 * reads `models[].status` and `mergeProviderIndexWithDetails` reads `source`.
 * Forcing the type meant these tests exercised a shape production never sees —
 * and the debt ratchet caught it. Building the real thing costs one helper and
 * makes the `status !== "deprecated"` filter reachable from here.
 */
function model(id: string, status: Model["status"] = "active"): Model {
  return {
    id,
    providerID: "opencode",
    api: { id, url: "https://api.test", npm: "@test/sdk" },
    name: id,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    status,
  }
}

function provider(id: string, models: Model[]): Provider {
  return {
    id,
    name: id,
    source: "config",
    env: [],
    options: {},
    models: Object.fromEntries(models.map((item) => [item.id, item])),
  }
}

function catalog(providers: Provider[], connected: string[] = []): ProviderListResponse {
  return { all: providers, connected, default: {} }
}


function project(id: string, worktree: string): Project {
  return {
    id,
    worktree,
    time: { created: 0, updated: 0 },
    sandboxes: [],
  }
}

describe("control-plane query helpers", () => {
  test("normalizeProjectList filters entries missing an id or worktree and sorts the rest by id", async () => {
    expect(normalizeProjectList([
      project("z", "/tmp/z"),
      project("a", "/tmp/a"),
      project("", "/tmp/blank"),
      project("no-worktree", ""),
    ]).map((item) => item.id)).toEqual(["a", "z"])
  })

  test("normalizeProjectList keeps projects whose worktree path happens to contain historical E2E-fixture substrings", async () => {
    // Production project filtering must never depend on internal E2E naming
    // conventions — a real user's worktree could legitimately contain either
    // substring (e.g. a directory literally named "opencode-test").
    expect(normalizeProjectList([
      project("skip", "/tmp/opencode-test-skip"),
      project("relay", "/private/var/folders/t2/relay/T/claxedo-signed-browser-relay-vMkcgb/workspace"),
    ]).map((item) => item.id)).toEqual(["relay", "skip"])
  })

  describe("projectCatalogMissingWorkspace", () => {
    const dir = "/Users/me/opencode"

    test("treats an engine-shaped entry for the directory as missing", () => {
      // The embedded OpenCode engine answers with a hashed id, `vcs`, and no
      // `workspaces` — the worktree matches, so only the workspace map
      // distinguishes it from the control-plane payload the rail needs.
      expect(projectCatalogMissingWorkspace(
        [{ ...project("ee9452087e23bf5d5c78b90f6ae74ef692a26b68", dir), vcs: "git" } as Project],
        dir,
      )).toBe(true)
    })

    test("treats a control-plane entry carrying the workspace as present", () => {
      expect(projectCatalogMissingWorkspace(
        [{ ...project("ws-uuid", dir), workspaces: { "ws-uuid": { directory: dir } } }],
        dir,
      )).toBe(false)
    })

    test("ignores control-plane entries for other directories", () => {
      expect(projectCatalogMissingWorkspace(
        [{ ...project("other", "/Users/me/other"), workspaces: { other: { directory: "/Users/me/other" } } }],
        dir,
      )).toBe(true)
    })

    test("reports missing for an empty or absent catalog", () => {
      expect(projectCatalogMissingWorkspace([], dir)).toBe(true)
      expect(projectCatalogMissingWorkspace(undefined, dir)).toBe(true)
    })

    test("never reports missing without a directory to check", () => {
      expect(projectCatalogMissingWorkspace([], "")).toBe(false)
    })
  })

  test("projectListQuery normalizes results", async () => {
    const query = projectListQuery({
      baseUrl: "http://example.test",
      client: {
        project: {
          list: async () => ({
            data: [
              project("b", "/tmp/b"),
              project("a", "/tmp/a"),
            ],
          }),
        },
      },
    })

    expect(query.queryKey).toEqual(["controlPlane", "http://example.test", "projects"])
    expect(query.staleTime).toBe(5 * 60 * 1000)
    expect((await query.queryFn()).map((item) => item.id)).toEqual(["a", "b"])
  })

  test("providerListQuery normalizes provider payloads", async () => {
    const providers = {
      all: [{ id: "openai", name: "OpenAI", source: "api", env: [], options: {}, models: {} }],
      connected: [],
      default: {},
    } satisfies ProviderListResponse
    const query = providerListQuery({
      baseUrl: "http://example.test",
      client: {
        provider: {
          list: async () => ({
            data: providers,
          }),
        },
      },
    })

    expect(query.queryKey).toEqual(["controlPlane", "http://example.test", "providers"])
    expect(query.staleTime).toBe(5 * 60 * 1000)
    expect(query.retry).toBe(2)
    expect(query.retryDelay).toBe(250)
    expect(Array.from((await query.queryFn()).all.keys())).toEqual(["openai"])
  })

  test("a late compact provider index preserves model details already loaded into the cache", () => {
    const detailed = normalizeProviderList({
      all: [{
        id: "anthropic",
        name: "Anthropic",
        source: "api",
        env: ["ANTHROPIC_API_KEY"],
        options: {},
        models: {
          sonnet: { id: "sonnet", name: "Sonnet" },
          opus: { id: "opus", name: "Opus" },
        },
      }],
      connected: ["anthropic"],
      default: { anthropic: "sonnet" },
    } as ProviderListResponse)
    const compact = normalizeProviderList({
      all: [{
        id: "anthropic",
        name: "Anthropic",
        source: "api",
        env: [],
        options: {},
        models: { sonnet: { id: "sonnet", name: "Sonnet" } },
      }],
      connected: ["anthropic"],
      default: { anthropic: "sonnet" },
    } as ProviderListResponse)

    const merged = mergeProviderIndexWithDetails(detailed, compact)

    expect(Object.keys(merged.all.get("anthropic")?.models ?? {})).toEqual(["sonnet", "opus"])
    expect(merged.all.get("anthropic")?.env).toEqual(["ANTHROPIC_API_KEY"])
  })

  test("providerAuthQuery uses a separate non-SWR auth bucket", async () => {
    const query = providerAuthQuery({
      baseUrl: "http://example.test",
      client: {
        provider: {
          auth: async () => ({
            data: {
              openai: [{ type: "api", authenticated: true }],
            },
          }),
        },
      },
    })

    expect(query.queryKey).toEqual(["controlPlane", "http://example.test", "providerAuth"])
    expect(query.staleTime).toBe(0)
    expect((await query.queryFn()).openai?.[0]?.authenticated).toBe(true)
  })

  // Harness catalogs belong to the runtime identified by `directory`, so the
  // same stable scope qualifies both the request and its cache entry.
  test("Pi provider queries use a harness-qualified cache key and a scope-qualified raw route", async () => {
    const calls: string[] = []
    const query = providerListQuery({
      baseUrl: "http://example.test",
      directory: "workspace:ws_1",
      harnessType: "pi",
      request: async (url) => {
        calls.push(String(url))
        return Response.json({ all: [], connected: [], default: {} })
      },
      client: { provider: { list: async () => { throw new Error("SDK route must not be used") } } },
    })

    expect(query.queryKey).toEqual(["controlPlane", "http://example.test", "providers", "workspace:ws_1", "pi"])
    await query.queryFn()
    expect(calls).toEqual(["http://example.test/provider?harness=pi&directory=workspace%3Aws_1"])
  })

  test("provider detail queries qualify the canonical provider route", async () => {
    const calls: string[] = []
    const query = providerDetailsQuery({
      baseUrl: "http://example.test",
      providerId: "anthropic",
      directory: "workspace:ws_1",
      harnessType: "pi",
      request: async (url) => {
        calls.push(String(url))
        return Response.json({
          all: [{ id: "anthropic", name: "Anthropic", source: "api", env: [], options: {}, models: {} }],
          connected: ["anthropic"],
          default: {},
        })
      },
    })

    expect(query.queryKey).toEqual(["controlPlane", "http://example.test", "providers", "workspace:ws_1", "pi"])
    expect((await query.queryFn()).all.has("anthropic")).toBe(true)
    expect(calls).toEqual([
      "http://example.test/provider?provider=anthropic&harness=pi&directory=workspace%3Aws_1",
    ])
  })
})

describe("provider cache identity", () => {
  // Unqualified `/provider` resolves to the configured default harness, which
  // is not always OpenCode (workspace/agent defaults return agent catalogs).
  // OpenCode therefore keeps its own cache key so settings and pickers never
  // read agent rows as the OpenCode popular list.
  const client = {} as Parameters<typeof providerListQuery>[0]["client"]

  test("an opencode-qualified query keeps its own key, distinct from unqualified", () => {
    expect(providerListQuery({ baseUrl: "http://x", client, directory: "/repo", harnessType: "opencode" }).queryKey)
      .not.toEqual(providerListQuery({ baseUrl: "http://x", client, directory: "/repo" }).queryKey)
    expect(providerListQuery({ baseUrl: "http://x", client, directory: "/repo", harnessType: "opencode" }).queryKey)
      .toEqual(["controlPlane", "http://x", "providers", "/repo", "opencode"])
  })

  test("every OTHER harness keeps its own key, because it serves a different catalog", () => {
    const unqualified = providerListQuery({ baseUrl: "http://x", client, directory: "/repo" }).queryKey
    expect(providerListQuery({ baseUrl: "http://x", client, directory: "/repo", harnessType: "pi" }).queryKey)
      .not.toEqual(unqualified)
    // ...and two non-default harnesses stay distinct from each other.
    expect(providerListQuery({ baseUrl: "http://x", client, directory: "/repo", harnessType: "pi" }).queryKey)
      .not.toEqual(providerListQuery({ baseUrl: "http://x", client, directory: "/repo", harnessType: "codex" }).queryKey)
  })

  test("providerCacheHarness is the single place that decides key identity", () => {
    expect(providerCacheHarness(undefined)).toBeUndefined()
    expect(providerCacheHarness("opencode")).toBe("opencode")
    expect(providerCacheHarness("pi")).toBe("pi")
  })
})

describe("an empty provider catalog never replaces a populated one", () => {
  // The rule used to be enforced by ONE writer (`setProviderQuery` in
  // bootstrap.ts) while the merge that owns how catalogs combine did not know
  // it. FOUR writers reach this key — `setBootstrapProviderQueries`, the
  // directory bootstrap's provider fetch, the globalSync patch handler
  // (`provider.tsx`, which writes `patch.provider` straight in), and
  // `providerListQuery`'s own `structuralSharing` — and only one was careful.
  // These pin the rule at the merge, so it holds for every consumer.
  const populated = normalizeProviderList(catalog([provider("opencode", [model("gpt-5")])], ["opencode"]))
  const empty = normalizeProviderList(catalog([]))

  test("keeps the populated catalog when an empty one arrives", () => {
    const merged = mergeProviderIndexWithDetails(populated, empty)
    expect([...merged.all.keys()]).toEqual(["opencode"])
    expect(merged.connected).toEqual(["opencode"])
  })

  test("an empty catalog is still accepted when there is nothing to protect", () => {
    expect(mergeProviderIndexWithDetails(undefined, empty).all.size).toBe(0)
    expect(mergeProviderIndexWithDetails(empty, empty).all.size).toBe(0)
  })

  test("a populated catalog still replaces a populated one — this is not a freeze", () => {
    const next = normalizeProviderList(catalog([provider("anthropic", [model("sonnet")])], ["anthropic"]))
    expect([...mergeProviderIndexWithDetails(populated, next).all.keys()]).toEqual(["anthropic"])
  })
})
