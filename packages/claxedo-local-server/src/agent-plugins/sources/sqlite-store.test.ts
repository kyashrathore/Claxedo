import Database from "better-sqlite3"
import { describe, expect, test } from "vitest"
import { agentPluginSourceRecord } from "@claxedo/server-core/agent-plugins/sources/registry"
import { AgentPluginSourceRegistryError } from "@claxedo/server-core/agent-plugins/sources/routes"
import { SqliteUnsignedAgentPluginActivationStore } from "../activation/sqlite-store"
import { SqliteAgentPluginSourceStore } from "./sqlite-store"

function record(owner: string, repository: string, addedAt: number, ref = "main") {
  return agentPluginSourceRecord({ owner, repository, ref, authority: "user" }, addedAt)
}

async function failure(promise: Promise<unknown>) {
  const caught = await promise.then(() => undefined, (cause: unknown) => cause)
  if (!(caught instanceof AgentPluginSourceRegistryError)) throw caught ?? new Error("expected a registry failure")
  return caught
}

describe("SqliteAgentPluginSourceStore", () => {
  test("stores machine-wide registrations in the order they were added", async () => {
    const store = new SqliteAgentPluginSourceStore(new Database(":memory:"))
    await store.add(undefined, record("acme", "plugins", 20))
    await store.add(undefined, record("beta", "tools", 10))

    expect(await store.list()).toEqual([
      {
        id: "github:beta/tools@main",
        kind: "personal",
        label: "beta/tools",
        owner: "beta",
        repository: "tools",
        ref: "main",
        authority: "user",
        addedAt: 10,
      },
      {
        id: "github:acme/plugins@main",
        kind: "personal",
        label: "acme/plugins",
        owner: "acme",
        repository: "plugins",
        ref: "main",
        authority: "user",
        addedAt: 20,
      },
    ])
    expect(store.canRemove()).toBe(true)
  })

  test("keeps one row per owner/repository/ref and refuses a duplicate", async () => {
    const store = new SqliteAgentPluginSourceStore(new Database(":memory:"))
    await store.add(undefined, record("acme", "plugins", 1))
    await store.add(undefined, record("acme", "plugins", 2, "release"))

    expect((await failure(store.add(undefined, record("acme", "plugins", 3)))).code).toBe("source-exists")
    expect((await store.list()).map((source) => source.ref)).toEqual(["main", "release"])
  })

  test("removes a registration and refuses an unknown id", async () => {
    const store = new SqliteAgentPluginSourceStore(new Database(":memory:"))
    await store.add(undefined, record("acme", "plugins", 1))

    expect((await failure(store.remove(undefined, "github:acme/nothing@main"))).code).toBe("source-unknown")
    await store.remove(undefined, "github:acme/plugins@main")
    expect(await store.list()).toEqual([])
  })

  test("shares the activation database without disturbing its tables", async () => {
    // Both stores create their own tables in the one machine database the
    // daemon opens; a source registration must not touch the activation
    // revision the runtime reconciles against.
    const database = new Database(":memory:")
    const activations = new SqliteUnsignedAgentPluginActivationStore(database)
    const sources = new SqliteAgentPluginSourceStore(database)

    await sources.add(undefined, record("acme", "plugins", 1))

    expect(activations.revision()).toBe(0)
    expect((await sources.list()).length).toBe(1)
  })
})
