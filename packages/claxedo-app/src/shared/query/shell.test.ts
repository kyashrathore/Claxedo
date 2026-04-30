import { describe, expect, test } from "bun:test"
import { commandListQuery, normalizeCommandList, normalizeProjectList, projectListQuery, providerListQuery } from "./shell"

describe("shell query helpers", () => {
  test("normalizeProjectList filters junk and sorts by id", async () => {
    expect(normalizeProjectList([
      { id: "z", worktree: "/tmp/z" },
      { id: "a", worktree: "/tmp/a" },
      { id: "skip", worktree: "/tmp/opencode-test-skip" },
      { id: "", worktree: "/tmp/blank" },
    ] as any).map((item) => item.id)).toEqual(["a", "z"])
  })

  test("projectListQuery normalizes results", async () => {
    const query = projectListQuery({
      baseUrl: "http://example.test",
      client: {
        project: {
          list: async () => ({
            data: [
              { id: "b", worktree: "/tmp/b" },
              { id: "a", worktree: "/tmp/a" },
            ] as any,
          }),
        },
      },
    })

    expect(query.queryKey).toEqual(["shell", "http://example.test", "projects"])
    expect((await query.queryFn()).map((item) => item.id)).toEqual(["a", "b"])
  })

  test("providerListQuery normalizes provider payloads", async () => {
    const query = providerListQuery({
      baseUrl: "http://example.test",
      client: {
        provider: {
          list: async () => ({
            data: {
              all: [{ id: "openai", models: [] }],
              connected: [],
              default: {},
            } as any,
          }),
        },
      },
    })

    expect(query.queryKey).toEqual(["shell", "http://example.test", "providers"])
    expect((await query.queryFn()).all.map((item) => item.id)).toEqual(["openai"])
  })

  test("commandListQuery normalizes command payloads", async () => {
    expect(normalizeCommandList([
      { name: "zzz", description: "last" },
      { name: "aaa", description: "first" },
      { name: "", description: "skip" },
    ] as any).map((item) => item.name)).toEqual(["aaa", "zzz"])

    const query = commandListQuery({
      baseUrl: "http://example.test",
      directory: "/tmp/ws",
      client: {
        command: {
          list: async () => ({
            data: [
              { name: "b", description: "second" },
              { name: "a", description: "first" },
            ] as any,
          }),
        },
      },
    })

    expect(query.queryKey).toEqual(["shell", "http://example.test", "commands", "/tmp/ws"])
    expect((await query.queryFn()).map((item) => item.name)).toEqual(["a", "b"])
  })
})
