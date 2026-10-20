import { describe, expect, mock, test } from "bun:test"
import type { PluginBackendState, PluginHostPort } from "./host-port"

void mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  },
}))

const { pluginSupervisorClass } = await import("./supervisor.cf")

const SCOPE = { orgId: "org_1", pluginId: "counter" }

function activeState(epoch: number): PluginBackendState {
  return {
    epoch,
    activation: {
      epoch,
      bundleHash: "a".repeat(64),
      manifest: {
        id: "counter",
        name: "Counter",
        version: "0.1.0",
        app: "./app.js",
        requires: [],
        server: { routes: [], operations: [] },
        backend: { entry: "./backend.js", objects: ["Counter"], outbound: [], routes: ["GET /count"] },
      },
    },
  }
}

/** A supervisor over a `ctx` that records, in order, what deletes the plugin's storage. */
function supervisor(state: PluginBackendState, recorded: readonly string[]) {
  const calls: string[] = []
  const ctx = {
    storage: {
      sql: {
        exec: (query: string) => {
          if (query.startsWith("create table")) calls.push("create plugin_facets")
          return { toArray: () => (query.startsWith("select name from plugin_facets") ? recorded.map((name) => ({ name })) : []) }
        },
      },
      deleteAll: async () => {
        calls.push("deleteAll")
      },
    },
    facets: {
      delete: (name: string) => calls.push(`delete ${name}`),
      abort: (name: string) => calls.push(`abort ${name}`),
    },
  }
  const port: PluginHostPort = { readState: async () => state, readBundle: async () => undefined }
  const Supervisor = pluginSupervisorClass(() => port)
  const object = new Supervisor(ctx as never, {} as never)
  calls.length = 0
  return { object, calls }
}

describe("purging a plugin's storage", () => {
  test("deletes every recorded facet by name before the supervisor's own storage, then recreates the registry", async () => {
    const { object, calls } = supervisor({ epoch: 4 }, ['["Counter","main"]', '["Counter","other"]'])
    await object.purge(SCOPE)
    expect(calls).toEqual(['delete ["Counter","main"]', 'delete ["Counter","other"]', "deleteAll", "create plugin_facets"])
  })

  test("refuses while the host still answers an active backend, and deletes nothing", async () => {
    const { object, calls } = supervisor(activeState(4), ['["Counter","main"]'])
    await expect(object.purge(SCOPE)).rejects.toThrow(/still active/)
    expect(calls).toEqual([])
  })

  test("refuses a scope other than the one the supervisor serves", async () => {
    const { object } = supervisor({ epoch: 4 }, [])
    await object.refresh(SCOPE)
    await expect(object.purge({ ...SCOPE, pluginId: "other" })).rejects.toThrow(/was asked about other/)
  })
})
