import { Database } from "bun:sqlite"
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

function activeState(epoch: number, permissions: string[] = []): PluginBackendState {
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
        permissions: permissions as never,
        backend: { entry: "./backend.js", objects: ["Counter"], outbound: [], routes: ["GET /count"] },
      },
    },
  }
}

/**
 * A supervisor over a `ctx` whose SQL is a real SQLite database and whose
 * facets, alarm and `deleteAll` record, in order, what they were asked.
 */
function supervisor(state: PluginBackendState) {
  const database = new Database(":memory:")
  const calls: string[] = []
  let alarm: number | null = null
  const ctx = {
    storage: {
      sql: {
        exec: (query: string, ...bindings: unknown[]) => {
          const statement = database.query(query)
          const rows = /^\s*select/i.test(query) ? (statement.all(...(bindings as never[])) as Record<string, unknown>[]) : (statement.run(...(bindings as never[])), [])
          return { toArray: () => rows }
        },
      },
      setAlarm: async (at: number) => {
        alarm = at
      },
      deleteAlarm: async () => {
        alarm = null
        calls.push("deleteAlarm")
      },
      deleteAll: async () => {
        for (const { name } of database.query("select name from sqlite_master where type = 'table'").all() as { name: string }[]) database.run(`drop table ${name}`)
        calls.push("deleteAll")
      },
    },
    facets: {
      delete: (name: string) => calls.push(`delete ${name}`),
      abort: (name: string) => calls.push(`abort ${name}`),
    },
  }
  const port: PluginHostPort = { readState: async () => state, readBundle: async () => undefined, platform: async () => ({ ok: true }) }
  const Supervisor = pluginSupervisorClass(() => port)
  const object = new Supervisor(ctx as never, {} as never)
  const facet = (name: string) => database.run("insert into plugin_facets (name, class_name, created_at) values (?, 'Counter', 1)", [name])
  return { object, calls, facet, alarm: () => alarm, tables: () => (database.query("select name from sqlite_master where type = 'table' order by name").all() as { name: string }[]).map((row) => row.name) }
}

describe("purging a plugin's storage", () => {
  test("deletes every recorded facet by name before the supervisor's own storage, then recreates its tables", async () => {
    const { object, calls, facet, tables } = supervisor({ epoch: 4 })
    facet('["Counter","main"]')
    facet('["Counter","other"]')
    await object.purge(SCOPE)
    expect(calls).toEqual(['delete ["Counter","main"]', 'delete ["Counter","other"]', "deleteAlarm", "deleteAll"])
    expect(tables()).toEqual(["plugin_blob_usage", "plugin_facets", "plugin_scope", "plugin_wakes"])
  })

  test("refuses while the host still answers an active backend, and deletes nothing", async () => {
    const { object, calls, facet } = supervisor(activeState(4))
    facet('["Counter","main"]')
    await expect(object.purge(SCOPE)).rejects.toThrow(/still active/)
    expect(calls).toEqual([])
  })

  test("refuses a scope other than the one the supervisor serves", async () => {
    const { object } = supervisor({ epoch: 4 })
    await object.refresh(SCOPE)
    await expect(object.purge({ ...SCOPE, pluginId: "other" })).rejects.toThrow(/was asked about other/)
  })
})

describe("scheduling a wake", () => {
  test("arms the supervisor's alarm at the earliest wake, refuses one set too soon, and disarms when none is left", async () => {
    const { object, alarm } = supervisor(activeState(4, ["schedule"]))
    const scope = { ...SCOPE, epoch: 4 }
    const now = Date.now()
    expect(await object.platform(scope, { name: "schedule.at", wake: "late", at: now + 120_000 }, undefined)).toEqual({ ok: true })
    expect(await object.platform(scope, { name: "schedule.at", wake: "early", at: now + 60_000, payload: { n: 1 } }, undefined)).toEqual({ ok: true })
    expect(alarm()).toBe(now + 60_000)
    expect(await object.platform(scope, { name: "schedule.at", wake: "soon", at: now + 1_000 }, undefined)).toMatchObject({ ok: false, code: "plugin_wake_too_soon" })
    expect(await object.platform(scope, { name: "schedule.list" }, undefined)).toEqual({
      ok: true,
      value: [
        { name: "early", at: now + 60_000, payload: { n: 1 } },
        { name: "late", at: now + 120_000 },
      ],
    })
    await object.platform(scope, { name: "schedule.cancel", wake: "early" }, undefined)
    expect(alarm()).toBe(now + 120_000)
    await object.platform(scope, { name: "schedule.cancel", wake: "late" }, undefined)
    expect(alarm()).toBeNull()
  })
})
