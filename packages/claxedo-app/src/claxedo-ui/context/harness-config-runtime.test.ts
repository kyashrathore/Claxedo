import { describe, expect, test } from "bun:test"
import { createHarnessConfigRuntime, type ProjectInventoryItem } from "./harness-config-runtime"

const responseFetch = (label: string): typeof fetch =>
  async (input) => Response.json({ label, url: String(input) })

function runtime(input?: {
  base?: string
  projects?: ProjectInventoryItem[]
  request?: typeof fetch
  unsignedLocalFetch?: typeof fetch
  transportFetch?: typeof fetch
  sdkFetch?: typeof fetch
}) {
  const transportFetch = input?.transportFetch ?? responseFetch("transport")
  const sdkFetch = input?.sdkFetch ?? responseFetch("sdk")
  return createHarnessConfigRuntime({
    base: input?.base ?? "http://127.0.0.1:3001",
    request: input?.request ?? responseFetch("request"),
    unsignedLocalFetch: input?.unsignedLocalFetch ?? responseFetch("unsigned"),
    projects: () => input?.projects ?? [],
    createTransport: () => ({
      fetch: transportFetch,
      sdkFetch,
      json: async () => ({}),
    }),
    resolveWorkspaceRuntime: async ({ directory, workspaceId }) => ({
      kind: directory.includes("cloud") ? "cloud" : "user-hosted",
      workspaceId: workspaceId ?? "ws_resolved",
    }),
  })
}

describe("harness config runtime", () => {
  test("uses unsigned local config fetch for loopback filesystem directories", () => {
    const unsigned = responseFetch("unsigned")
    const request = responseFetch("request")
    const harnessRuntime = runtime({ unsignedLocalFetch: unsigned, request })

    expect(harnessRuntime.useLocalHarnessConfig({ directory: "/tmp/project" })).toBe(true)
    expect(harnessRuntime.localHarnessConfigFetch({ directory: "/tmp/project" })).toBe(unsigned)
  })

  test("uses authenticated request for hosted control planes", () => {
    const unsigned = responseFetch("unsigned")
    const request = responseFetch("request")
    const harnessRuntime = runtime({
      base: "https://claxedo.example.test",
      unsignedLocalFetch: unsigned,
      request,
    })

    expect(harnessRuntime.useLocalHarnessConfig({ directory: "/tmp/project" })).toBe(false)
    expect(harnessRuntime.localHarnessConfigFetch({ directory: "/tmp/project" })).toBe(request)
  })

  test("prefers workspace runtime transport over local config fetch for workspace refs", () => {
    const sdkFetch = responseFetch("sdk")
    const unsigned = responseFetch("unsigned")
    const harnessRuntime = runtime({ sdkFetch, unsignedLocalFetch: unsigned })

    expect(harnessRuntime.harnessSessionFetch({ directory: "workspace:ws_1" })).toBe(sdkFetch)
  })

  test("returns empty options without a directory", async () => {
    const res = await runtime().configOptionsFetch("claude-acp")

    expect(await res.json()).toEqual({
      options: [],
      source: "empty",
      stale: false,
    })
  })

  test("scopes workspace-runtime option discovery to the selected harness", async () => {
    const urls: string[] = []
    const harnessRuntime = runtime({
      transportFetch: async (input) => {
        urls.push(String(input))
        return Response.json({ ok: true })
      },
    })

    await harnessRuntime.configOptionsFetch("codex-acp", { directory: "workspace:ws_cloud" })

    expect(urls).toEqual([
      "/api/wr/harness-config-options?directory=workspace%3Aws_cloud&harness=codex-acp",
    ])
  })

  test("looks up project inventory workspace kind without freezing project data", () => {
    let projects: ProjectInventoryItem[] = [{
      worktree: "/repo",
      sandboxes: ["/repo/sandbox"],
      workspaces: {
        "/repo/sandbox": { kind: "user-hosted" },
      },
    }]
    const harnessRuntime = createHarnessConfigRuntime({
      base: "http://127.0.0.1:3001",
      request: responseFetch("request"),
      projects: () => projects,
    })

    expect(harnessRuntime.useLocalHarnessConfig({ directory: "/repo/sandbox" })).toBe(false)

    projects = [{
      worktree: "/repo",
      sandboxes: ["/repo/sandbox"],
      workspaces: {
        "/repo/sandbox": { kind: "local" },
      },
    }]
    expect(harnessRuntime.useLocalHarnessConfig({ directory: "/repo/sandbox" })).toBe(true)
  })

  test("stays out of query and store ownership", async () => {
    const source = await Bun.file(new URL("./harness-config-runtime.ts", import.meta.url)).text()

    expect(source).not.toContain("queryClient")
    expect(source).not.toContain("setQueryData")
    expect(source).not.toContain("removeQueries")
    expect(source).not.toContain("createStore")
    expect(source).not.toContain("@tanstack")
  })
})
