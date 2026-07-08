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
  test("normalizeProjectList filters junk and sorts by id", async () => {
    expect(normalizeProjectList([
      project("z", "/tmp/z"),
      project("a", "/tmp/a"),
      project("skip", "/tmp/opencode-test-skip"),
      project("relay", "/private/var/folders/t2/relay/T/claxedo-signed-browser-relay-vMkcgb/workspace"),
      project("", "/tmp/blank"),
    ]).map((item) => item.id)).toEqual(["a", "z"])
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
})
