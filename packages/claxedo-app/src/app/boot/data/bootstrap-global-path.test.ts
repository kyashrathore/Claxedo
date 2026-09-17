import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { bootstrapGlobal } from "./bootstrap"

afterEach(() => queryClient.clear())

const baseUrl = "http://127.0.0.1:2593"

// The daemon's global aggregate as `localBootstrapBody` serves it: no project
// is scoped, so `worktree` and `directory` are "" while `home` is real.
const globalBoot = {
  healthy: true,
  version: "1.0.0",
  path: {
    home: "/Users/someone",
    state: "/Users/someone/.claxedo-dev/state",
    config: "/Users/someone/.claxedo-dev",
    worktree: "",
    directory: "",
  },
  project: [],
  provider_auth: {},
}

function run(body: unknown) {
  const patches: Array<Record<string, unknown>> = []
  const fetchFn = (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch
  return bootstrapGlobal({
    baseUrl,
    fetch: fetchFn,
    globalSDK: {
      global: { health: async () => { throw new Error("health must not be consulted when the aggregate answered") } },
      path: { get: async () => { throw new Error("path must not be re-read when the aggregate answered") } },
    } as never,
    connectErrorTitle: "connect",
    connectErrorDescription: "connect",
    requestFailedTitle: "failed",
    translate: (key) => key,
    formatMoreCount: (n) => String(n),
    setGlobalState: (patch) => { patches.push(patch) },
  }).then(() => patches)
}

describe("bootstrapGlobal path", () => {
  test("keeps home from a global aggregate whose worktree and directory are empty by contract", async () => {
    const patches = await run(globalBoot)
    expect(queryClient.getQueryData(queryKeys.directory.path(baseUrl, ""))).toEqual(globalBoot.path)
    expect(patches.find((p) => "path" in p)?.path).toEqual(globalBoot.path)
  })

  test("a path missing a member is still dropped, not padded", async () => {
    const { home: _home, ...withoutHome } = globalBoot.path
    await run({ ...globalBoot, path: withoutHome })
    expect(queryClient.getQueryData(queryKeys.directory.path(baseUrl, ""))).toEqual({
      home: "", state: "", config: "", worktree: "", directory: "",
    })
  })
})
