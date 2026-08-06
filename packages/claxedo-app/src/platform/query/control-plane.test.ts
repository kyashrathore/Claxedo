import { describe, expect, test } from "bun:test"
import type { Project, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import {
  normalizeProjectList,
  projectCatalogMissingWorkspace,
  projectListQuery,
  providerAuthQuery,
  providerListQuery,
} from "./control-plane"
import { mergeProviderIndexWithDetails, normalizeProviderList } from "./provider-list"

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

  // The scope travels in the REQUEST (`?directory=`) but never in the cache
  // key: one server serves one catalog per harness, and both bootstraps warm
  // the scope-less key. Keying reads by scope stranded each pane on a private
  // entry nothing warms, which is what reverted a picked model to
  // "Select model" — see `global-sync/provider-cache-scope.test.ts`.
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

    expect(query.queryKey).toEqual(["controlPlane", "http://example.test", "providers", "", "pi"])
    await query.queryFn()
    expect(calls).toEqual(["http://example.test/provider?harness=pi&directory=workspace%3Aws_1"])
  })
})
