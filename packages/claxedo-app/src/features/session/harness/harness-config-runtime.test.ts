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

  test("classifies signed loopback filesystem workspaces when inventory is keyed by workspace id", () => {
    const harnessRuntime = runtime({
      projects: [{
        worktree: "ws_cloud",
        sandboxes: ["/repo/signed"],
        workspaces: {
          ws_cloud: {
            id: "ws_cloud",
            workspaceId: "ws_cloud",
            kind: "cloud",
            directory: "/repo/signed",
          },
        },
      }],
    })

    expect(harnessRuntime.workspaceKind({ directory: "/repo/signed" })).toBe("cloud")
    expect(harnessRuntime.useLocalHarnessConfig({ directory: "/repo/signed" })).toBe(false)
  })

  test("keeps ordinary local inventory on the loopback harness config API", () => {
    const harnessRuntime = runtime({
      projects: [{
        worktree: "/repo/local",
        workspaces: {
          ws_local: {
            id: "ws_local",
            kind: "local",
            directory: "/repo/local",
          },
        },
      }],
    })

    expect(harnessRuntime.useLocalHarnessConfig({ directory: "/repo/local" })).toBe(true)
  })

  // A signed user-hosted workspace addressed by its filesystem-path directory
  // (the registration-stored remote_directory, not a `ws_`/`workspace:` ref)
  // must still resolve to its workspaceId and get a relay placement — not fall
  // through to the plain central transport, which serves none of the
  // `/api/wr/*` runtime paths.
  test("routes signed user-hosted harness config options through the workspace relay for a filesystem directory", async () => {
    const placements: unknown[] = []
    const harnessRuntime = createHarnessConfigRuntime({
      base: "https://claxedo.example.test",
      request: responseFetch("request"),
      projects: () => [{
        worktree: "/repo",
        workspaces: {
          ws_uh1: {
            id: "ws_uh1",
            workspaceId: "ws_uh1",
            kind: "user-hosted",
            directory: "/repo/user-hosted/ws_uh1-dir",
          },
        },
      }],
      createTransport: (input: { placement: unknown }) => {
        placements.push(input.placement)
        return {
          fetch: async () => Response.json({ ok: true }),
          sdkFetch: responseFetch("sdk"),
          json: async () => ({}),
        }
      },
    })

    await harnessRuntime.configOptionsFetch("claude-acp", { directory: "/repo/user-hosted/ws_uh1-dir" })

    expect(placements).toEqual([{
      workspaceId: "ws_uh1",
      hosting: "workspace",
      transport: "workspace-relay",
    }])
  })

})
