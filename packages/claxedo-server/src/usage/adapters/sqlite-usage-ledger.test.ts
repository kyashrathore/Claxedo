import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import type { TurnUsageRevision } from "@claxedo/server-core/usage/contracts"
import { CLAXEDO_MIGRATION_JOURNAL } from "@claxedo/server-core/platform/db/journal"
import { createSqliteUsageLedger } from "@claxedo/server-core/usage/adapters/sqlite-usage-ledger"
import { createSqliteTurnMeterStateStore } from "@claxedo/server-core/usage/adapters/sqlite-turn-meter-state"
import { USAGE_REPORT_MAX_MESSAGES_PER_TURN } from "@claxedo/server-core/usage/usage-report"

/** A database with every migration in the journal applied, the way a booted machine has it. */
function migrated() {
  const sqlite = new Database(":memory:")
  for (const name of readdirSync(CLAXEDO_MIGRATION_JOURNAL).toSorted()) {
    const file = path.join(CLAXEDO_MIGRATION_JOURNAL, name, "migration.sql")
    if (existsSync(file)) sqlite.exec(readFileSync(file, "utf8"))
  }
  return sqlite
}

function database(sqlite: InstanceType<typeof Database>) {
  const db = drizzle({ client: sqlite })
  return {
    use: <T>(callback: (client: typeof db) => T) => callback(db),
    transaction: <T>(callback: (client: typeof db) => T) =>
      (db.transaction as unknown as (run: (client: typeof db) => T) => T)(callback),
  }
}

function harness() {
  const sqlite = migrated()
  return { sqlite, ledger: createSqliteUsageLedger({ database: database(sqlite) as never }) }
}

function revision(input: Partial<TurnUsageRevision> = {}): TurnUsageRevision {
  return {
    sessionRef: "local:project-a:session:same-session",
    sessionId: "same-session",
    messageId: "msg_provider_1",
    revision: 1,
    observedAt: 1_000,
    settlement: "provisional",
    status: "running",
    location: "local",
    harness: "claude-sdk",
    providerId: "anthropic",
    modelId: "claude-sonnet-5",
    workspaceId: "workspace-a",
    hostId: "host-a",
    tokens: { input: 10, output: 2, reasoning: null, cache: { read: 3, write: null } },
    quality: {
      source: "provider",
      observationKind: "cumulative",
      knownCategories: ["input", "output", "cache_read"],
    },
    ...input,
  }
}

describe("sqlite usage ledger", () => {
  test("atomically records provisional and final revisions while only the final contributes", async () => {
    const { sqlite, ledger } = harness()
    expect(await ledger.writeRevision(revision())).toEqual({ status: "accepted" })
    expect(
      await ledger.writeRevision(
        revision({
          revision: 2,
          observedAt: 2_000,
          completedAt: 2_000,
          settlement: "final",
          status: "completed",
          tokens: { input: 10, output: 8, reasoning: null, cache: { read: 3, write: null } },
        }),
      ),
    ).toEqual({ status: "accepted" })

    expect(sqlite.prepare("SELECT revision, settlement, output_tokens FROM claxedo_usage_turn_current").all()).toEqual([
      { revision: 2, settlement: "final", output_tokens: 8 },
    ])
    expect(sqlite.prepare("SELECT revision FROM claxedo_usage_turn_revision ORDER BY revision").all()).toEqual([
      { revision: 1 },
      { revision: 2 },
    ])
  })

  test("makes identical replay idempotent and rejects stale or conflicting revisions", async () => {
    const { sqlite, ledger } = harness()
    const first = revision()
    expect(await ledger.writeRevision(first)).toEqual({ status: "accepted" })
    expect(await ledger.writeRevision(first)).toEqual({ status: "duplicate" })
    await expect(ledger.writeRevision(revision({ revision: 0 }))).rejects.toThrow("positive integer")
    expect(await ledger.writeRevision(revision({ revision: 1, tokens: { ...first.tokens, output: 99 } }))).toEqual({
      status: "conflict",
      currentRevision: 1,
    })
    expect(await ledger.writeRevision(revision({ revision: 2 }))).toEqual({ status: "accepted" })
    expect(await ledger.writeRevision(first)).toEqual({ status: "stale", currentRevision: 2 })
    expect(sqlite.prepare("SELECT count(*) AS count FROM claxedo_usage_turn_revision").get()).toEqual({ count: 2 })
  })

  test("replays a fact built in another key order as the same revision", async () => {
    const { ledger } = harness()
    const first = revision({ quality: { source: "provider", observationKind: "cumulative", knownCategories: ["input", "output", "cache_read"] } })
    await ledger.writeRevision(first)
    const reordered = {
      ...first,
      tokens: { cache: { write: null, read: 3 }, reasoning: null, output: 2, input: 10 },
      quality: { knownCategories: ["cache_read", "output", "input"], observationKind: "cumulative", source: "provider" },
    } as TurnUsageRevision
    expect(await ledger.writeRevision(reordered)).toEqual({ status: "duplicate" })
  })

  test("isolates the same provider message id by canonical session ref", async () => {
    const { ledger } = harness()
    await ledger.writeRevision(revision())
    await ledger.writeRevision(revision({ sessionRef: "local:project-b:session:same-session" }))
    expect(await ledger.current()).toHaveLength(2)
  })

  test("reopens current facts and ownership without process memory", async () => {
    const { sqlite, ledger } = harness()
    const owner = { org_id: "org-a", user_id: "user-a" }
    const fact = revision()
    await ledger.writeRevision(fact, { owner })
    const reopened = createSqliteUsageLedger({ database: database(sqlite) as never })
    expect(await reopened.current()).toEqual([fact])
    expect(await reopened.ownedBy(owner)).toEqual([fact])
  })

  test("a turn belongs to the account its producer named, and to nobody else", async () => {
    const { ledger } = harness()
    const accountA = { org_id: "org-a", user_id: "user-a" }
    const accountB = { org_id: "org-b", user_id: "user-b" }
    await ledger.writeRevision(revision({ messageId: "a-fact" }), { owner: accountA })
    await ledger.writeRevision(revision({ messageId: "b-fact" }), { owner: accountB })
    await ledger.writeRevision(revision({ messageId: "machine-fact" }))

    expect((await ledger.ownedBy(accountA)).map((item) => item.messageId)).toEqual(["a-fact"])
    expect((await ledger.ownedBy(accountB)).map((item) => item.messageId)).toEqual(["b-fact"])
    expect((await ledger.current()).map((item) => item.messageId)).toEqual(["a-fact", "b-fact", "machine-fact"])
  })

  test("reads a turn's latest revision under the owner an earlier revision was stamped with", async () => {
    const { sqlite, ledger } = harness()
    const owner = { org_id: "org-a", user_id: "user-a" }
    await ledger.writeRevision(revision(), { owner })
    // After a restart the meter restores the turn without its owner.
    const final = revision({ revision: 2, settlement: "final", status: "completed" })
    await ledger.writeRevision(final)

    expect(await ledger.ownedBy(owner)).toEqual([final])
    expect(sqlite.prepare("SELECT org_id, user_id FROM claxedo_usage_turn_owner").all()).toEqual([
      { org_id: "org-a", user_id: "user-a" },
    ])
  })

  test("a machine turn stays the machine's however many accounts read", async () => {
    const { sqlite, ledger } = harness()
    await ledger.writeRevision(revision())
    for (const account of [{ org_id: "org-a", user_id: "user-a" }, { org_id: "org-b", user_id: "user-b" }]) {
      expect(await ledger.ownedBy(account)).toEqual([])
    }
    expect(sqlite.prepare("SELECT count(*) AS count FROM claxedo_usage_turn_owner").get()).toEqual({ count: 0 })
  })

  test("files a reported turn up to its message cap, and still takes a later revision of a message it holds", async () => {
    const { ledger } = harness()
    const owner = { org_id: "org-a", user_id: "user-a" }
    const filing = { owner, turnId: "msg_user_1" }
    const cloud = (input: Partial<TurnUsageRevision>) => revision({ location: "cloud-workspace", ...input })
    for (let index = 0; index < USAGE_REPORT_MAX_MESSAGES_PER_TURN; index++) {
      expect(await ledger.reports.writeRevision(cloud({ messageId: `msg_${index}` }), filing)).toEqual({ status: "accepted" })
    }

    expect(await ledger.reports.writeRevision(cloud({ messageId: "msg_over" }), filing))
      .toEqual({ status: "refused", code: "usage_turn_full" })
    expect(await ledger.reports.writeRevision(cloud({ messageId: "msg_0", revision: 2 }), filing)).toEqual({ status: "accepted" })
    expect(await ledger.reports.writeRevision(cloud({ messageId: "msg_over" }), { owner, turnId: "msg_user_2" }))
      .toEqual({ status: "accepted" })
    expect(await ledger.reports.writeRevision(
      cloud({ messageId: "msg_over_elsewhere", sessionRef: "workspace:ws_main:session:other" }),
      filing,
    )).toEqual({ status: "accepted" })
    expect(await ledger.ownedBy(owner)).toHaveLength(USAGE_REPORT_MAX_MESSAGES_PER_TURN + 2)
  })

  test("a later reported revision updates a message's usage but never refiles it under another member or turn", async () => {
    const { sqlite, ledger } = harness()
    const alice = { org_id: "org-a", user_id: "alice" }
    const bob = { org_id: "org-a", user_id: "bob" }
    const cloud = (input: Partial<TurnUsageRevision>) => revision({ location: "cloud-workspace", ...input })
    expect(await ledger.reports.writeRevision(cloud({}), { owner: alice, turnId: "msg_user_alice" })).toEqual({ status: "accepted" })
    expect(await ledger.reports.writeRevision(cloud({ revision: 2, tokens: { input: 5, output: 1, reasoning: null, cache: { read: null, write: null } } }), {
      owner: bob,
      turnId: "msg_user_bob",
    })).toEqual({ status: "accepted" })

    expect(await ledger.ownedBy(bob)).toEqual([])
    expect(await ledger.ownedBy(alice)).toEqual([expect.objectContaining({ revision: 2, tokens: expect.objectContaining({ input: 5 }) })])
    expect(sqlite.prepare("SELECT user_id, turn_id FROM claxedo_usage_turn_owner").all()).toEqual([{ user_id: "alice", turn_id: "msg_user_alice" }])
  })

  test("rolls back the fact when its owner cannot be filed", async () => {
    const { sqlite, ledger } = harness()
    sqlite.exec(
      `CREATE TRIGGER fail_usage_owner BEFORE INSERT ON claxedo_usage_turn_owner BEGIN SELECT RAISE(FAIL, 'owner down'); END`,
    )
    await expect(ledger.writeRevision(revision(), { owner: { org_id: "org-a", user_id: "user-a" } })).rejects.toThrow("owner down")
    expect(sqlite.prepare("SELECT count(*) AS count FROM claxedo_usage_turn_revision").get()).toEqual({ count: 0 })
    expect(sqlite.prepare("SELECT count(*) AS count FROM claxedo_usage_turn_current").get()).toEqual({ count: 0 })
  })

  test("the persisted fact has no content or secret fields", async () => {
    const { ledger } = harness()
    await ledger.writeRevision(revision())
    const encoded = JSON.stringify((await ledger.current())[0])
    for (const forbidden of ["prompt", "response", "directory", "credential", "auth", "apiKey"]) {
      expect(encoded).not.toContain(forbidden)
    }
  })

  test("keeps the one-hour share of cache writes, and a fact without one replays as itself", async () => {
    const { ledger } = harness()
    const split = revision({ tokens: { input: 1, output: 1, reasoning: null, cache: { read: 3, write: 100, write1h: 70 } } })
    const unsplit = revision({ messageId: "msg_provider_2", tokens: { input: 1, output: 1, reasoning: null, cache: { read: 3, write: 40, write1h: null } } })
    await ledger.writeRevision(split)
    await ledger.writeRevision(unsplit)

    const current = await ledger.current()
    expect(current.find((fact) => fact.messageId === split.messageId)?.tokens.cache).toEqual({ read: 3, write: 100, write1h: 70 })
    expect(current.find((fact) => fact.messageId === unsplit.messageId)?.tokens.cache).toEqual({ read: 3, write: 40 })
    await expect(ledger.writeRevision(unsplit)).resolves.toMatchObject({ status: "duplicate" })
    await expect(ledger.writeRevision(current.find((fact) => fact.messageId === unsplit.messageId)!)).resolves.toMatchObject({ status: "duplicate" })
  })

  test("refuses a one-hour share larger than the cache writes it is part of", async () => {
    const { ledger } = harness()
    await expect(
      ledger.writeRevision(revision({ tokens: { input: 1, output: 1, reasoning: null, cache: { read: null, write: 10, write1h: 11 } } })),
    ).rejects.toThrow("one-hour cache writes cannot exceed cache writes")
  })

  test("persists provider-native identity for overlap classification", async () => {
    const { ledger } = harness()
    await ledger.writeRevision(revision({ nativeSessionId: "provider-thread-1" }))
    expect((await ledger.current())[0]?.nativeSessionId).toBe("provider-thread-1")
  })

  test("bounds current and owned reads to the requested inclusive range", async () => {
    const { ledger } = harness()
    const owner = { org_id: "org-a", user_id: "user-a" }
    await ledger.writeRevision(revision({ messageId: "before", observedAt: 999 }), { owner })
    await ledger.writeRevision(revision({ messageId: "start", observedAt: 1_000 }), { owner })
    await ledger.writeRevision(revision({ messageId: "end", observedAt: 2_000 }), { owner })
    await ledger.writeRevision(revision({ messageId: "after", observedAt: 2_001 }), { owner })

    expect((await ledger.current({ since: 1_000, until: 2_000 })).map((item) => item.messageId)).toEqual([
      "start",
      "end",
    ])
    expect(
      (await ledger.ownedBy(owner, { since: 1_000, until: 2_000 })).map((item) => item.messageId),
    ).toEqual(["start", "end"])
  })

  test("filters current turns by settlement for bounded startup recovery", async () => {
    const { ledger } = harness()
    await ledger.writeRevision(revision({ messageId: "running" }))
    await ledger.writeRevision(
      revision({
        messageId: "finished",
        settlement: "final",
        status: "completed",
      }),
    )

    expect((await ledger.current({ settlement: "provisional" })).map((item) => item.messageId)).toEqual(["running"])
  })

  test("finds one settled turn through its durable primary-key identity", async () => {
    const { ledger } = harness()
    await ledger.writeRevision(revision({ messageId: "wanted", settlement: "final", status: "completed" }))
    await ledger.writeRevision(revision({ messageId: "other", settlement: "final", status: "completed" }))

    expect(
      (
        await ledger.current({
          sessionId: "same-session",
          messageId: "wanted",
        })
      ).map((item) => item.messageId),
    ).toEqual(["wanted"])
  })
})

describe("sqlite turn meter state", () => {
  test("keeps each turn's streams and replay keys, and a later save replaces them", async () => {
    const sqlite = migrated()
    const store = createSqliteTurnMeterStateStore({ database: database(sqlite) as never })
    const tokens = (input: number) => ({ input, output: 0, reasoning: null, cache: { read: null, write: 4, write1h: 3 } })
    await store.save({
      sessionId: "s1",
      messageId: "m1",
      state: { streams: { "": tokens(60) }, lastObservationKeys: { "": "k1" } },
    })
    const later = { streams: { "": tokens(60), toolu_sub: tokens(40) }, lastObservationKeys: { "": "k1", toolu_sub: "k2" } }
    await store.save({ sessionId: "s1", messageId: "m1", state: later })

    expect(await store.load({ sessionId: "s1", messageId: "m1" })).toEqual(later)
    expect(await store.load({ sessionId: "s1", messageId: "m2" })).toBeUndefined()
  })

  test("a stored state any part of which cannot be read loads as none", async () => {
    const sqlite = migrated()
    const store = createSqliteTurnMeterStateStore({ database: database(sqlite) as never })
    const insert = sqlite.prepare(
      "INSERT INTO claxedo_usage_turn_meter_state (session_id, message_id, streams_json, observation_keys_json) VALUES (?, ?, ?, ?)",
    )
    insert.run("s1", "negative", JSON.stringify({ "": { input: -1, output: 0, reasoning: null, cache: { read: null, write: null } } }), "{}")
    insert.run("s1", "key", "{}", JSON.stringify({ "": 7 }))
    insert.run("s1", "json", "{", "{}")

    for (const messageId of ["negative", "key", "json"]) {
      expect(await store.load({ sessionId: "s1", messageId }), messageId).toBeUndefined()
    }
  })
})
