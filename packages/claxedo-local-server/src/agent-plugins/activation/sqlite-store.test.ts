import Database from "better-sqlite3"
import { describe, expect, test } from "vitest"
import { AgentPluginActivationStoreError } from "@claxedo/server-core/agent-plugins/activation/store"
import { SqliteUnsignedAgentPluginActivationStore } from "./sqlite-store"

const digest = (character: string) => `sha256:${character.repeat(64)}` as const

function store() {
  return new SqliteUnsignedAgentPluginActivationStore(new Database(":memory:"))
}

function nullOnMissingStore() {
  const db = new Database(":memory:")
  return new SqliteUnsignedAgentPluginActivationStore({
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const statement = db.prepare(sql)
      return {
        get: (...params) => statement.get(...params) ?? null,
        all: (...params) => statement.all(...params),
        run: (...params) => statement.run(...params),
      }
    },
    transaction: (fn) => db.transaction(fn),
  })
}

describe("SqliteUnsignedAgentPluginActivationStore", () => {
  test("treats Bun SQLite's null missing-row result as no activation", () => {
    expect(nullOnMissingStore().read("plugin-a", "opencode")).toEqual({
      revision: 0,
      pluginInstanceId: "plugin-a",
      harnessId: "opencode",
      pins: {},
    })
  })

  test("stores one machine-wide tri-state override independently per harness", () => {
    const subject = store()

    const enabledRevision = subject.mutate({
      pluginInstanceId: "plugin-a",
      harnessIds: ["opencode", "claude"],
      choice: true,
      artifact: { digest: digest("a"), sourceId: "claxedo", relativePath: "plugin-a", sourceRevision: "main" },
      expectedRevision: 0,
    })
    expect(enabledRevision).toBe(1)
    expect(subject.read("plugin-a", "opencode")).toMatchObject({
      revision: 1,
      machineOverride: true,
      pins: { localMachine: digest("a") },
    })
    expect(subject.read("plugin-a", "claude")).toMatchObject({ machineOverride: true })
    expect(subject.read("plugin-a", "codex").machineOverride).toBeUndefined()
    expect(subject.listKnown()).toEqual([{
      pluginInstanceId: "plugin-a",
      pin: {
        digest: digest("a"),
        sourceId: "claxedo",
        relativePath: "plugin-a",
        sourceRevision: "main",
      },
    }])

    const disabledRevision = subject.mutate({
      pluginInstanceId: "plugin-a",
      harnessIds: ["claude"],
      choice: false,
      expectedRevision: enabledRevision,
    })
    expect(disabledRevision).toBe(2)
    expect(subject.read("plugin-a", "claude").machineOverride).toBe(false)

    subject.mutate({
      pluginInstanceId: "plugin-a",
      harnessIds: ["claude"],
      choice: undefined,
      expectedRevision: disabledRevision,
    })
    expect(subject.read("plugin-a", "claude").machineOverride).toBeUndefined()
    expect(subject.read("plugin-a", "claude").pins.localMachine).toBe(digest("a"))
  })

  test("requires a retained owner pin before a true choice", () => {
    const subject = store()

    expect(() => subject.mutate({
      pluginInstanceId: "plugin-a",
      harnessIds: ["opencode"],
      choice: true,
      expectedRevision: 0,
    })).toThrowError(expect.objectContaining<Partial<AgentPluginActivationStoreError>>({ code: "artifact-unavailable" }))
    expect(subject.revision()).toBe(0)
  })

  test("rejects unsupported harnesses atomically", () => {
    const subject = store()

    expect(() => subject.mutate({
      pluginInstanceId: "plugin-a",
      harnessIds: ["opencode", "imaginary"],
      choice: true,
      artifact: { digest: digest("a"), sourceId: "claxedo", relativePath: "plugin-a", sourceRevision: "main" },
      expectedRevision: 0,
    })).toThrowError(expect.objectContaining<Partial<AgentPluginActivationStoreError>>({ code: "unsupported-harness" }))
    expect(subject.revision()).toBe(0)
    expect(subject.read("plugin-a", "opencode").machineOverride).toBeUndefined()
  })

  test("uses compare-and-swap revisions so stale concurrent choices cannot win silently", () => {
    const subject = store()
    subject.mutate({
      pluginInstanceId: "plugin-a",
      harnessIds: ["opencode"],
      choice: true,
      artifact: { digest: digest("a"), sourceId: "claxedo", relativePath: "plugin-a", sourceRevision: "main" },
      expectedRevision: 0,
    })

    expect(() => subject.mutate({
      pluginInstanceId: "plugin-a",
      harnessIds: ["opencode"],
      choice: false,
      expectedRevision: 0,
    })).toThrowError(expect.objectContaining<Partial<AgentPluginActivationStoreError>>({ code: "revision-conflict" }))
    expect(subject.read("plugin-a", "opencode").machineOverride).toBe(true)
  })

  test("does not key unsigned choices by project", () => {
    const subject = store()
    subject.mutate({
      pluginInstanceId: "plugin-a",
      harnessIds: ["cursor"],
      choice: true,
      artifact: { digest: digest("a"), sourceId: "claxedo", relativePath: "plugin-a", sourceRevision: "main" },
      expectedRevision: 0,
    })

    // Two local projects ask the same store for the same plugin/harness. There
    // is deliberately no project argument with which their answers could vary.
    const firstProject = subject.read("plugin-a", "cursor")
    const secondProject = subject.read("plugin-a", "cursor")
    expect(secondProject).toEqual(firstProject)
  })
})
