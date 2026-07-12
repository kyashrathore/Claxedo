import { describe, expect, test } from "bun:test"
import type { Project, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { normalizeProjectList, projectListQuery, providerAuthQuery, providerListQuery } from "./control-plane"

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

  test("Pi provider queries use a harness- and scope-qualified cache key and raw route", async () => {
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
})
