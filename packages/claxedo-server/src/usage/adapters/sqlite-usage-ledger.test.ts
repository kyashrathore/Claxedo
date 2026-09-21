import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { describe, expect, test } from "vitest"
import type { TurnUsageRevision } from "@claxedo/server-core/usage/contracts"
import { createSqliteUsageLedger } from "@claxedo/server-core/usage/adapters/sqlite-usage-ledger"

const schema = `
CREATE TABLE claxedo_usage_turn_revision (
  host_id TEXT NOT NULL, session_ref TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
  revision INTEGER NOT NULL, payload_hash TEXT NOT NULL, observed_at INTEGER NOT NULL, completed_at INTEGER,
  settlement TEXT NOT NULL, status TEXT NOT NULL, location TEXT NOT NULL, harness TEXT NOT NULL,
  provider_id TEXT NOT NULL, model_id TEXT NOT NULL, native_session_id TEXT, workspace_id TEXT,
  input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_tokens INTEGER,
  cache_write_tokens INTEGER, quality_json TEXT NOT NULL,
  PRIMARY KEY (host_id, session_ref, message_id, revision)
);
CREATE TABLE claxedo_usage_turn_current (
  host_id TEXT NOT NULL, session_ref TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
  revision INTEGER NOT NULL, payload_hash TEXT NOT NULL, observed_at INTEGER NOT NULL, completed_at INTEGER,
  settlement TEXT NOT NULL, status TEXT NOT NULL, location TEXT NOT NULL, harness TEXT NOT NULL,
  provider_id TEXT NOT NULL, model_id TEXT NOT NULL, native_session_id TEXT, workspace_id TEXT,
  input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_tokens INTEGER,
  cache_write_tokens INTEGER, quality_json TEXT NOT NULL,
  PRIMARY KEY (host_id, session_ref, message_id)
);
CREATE TABLE claxedo_usage_outbox (
  host_id TEXT NOT NULL, session_ref TEXT NOT NULL, message_id TEXT NOT NULL, revision INTEGER NOT NULL,
  payload_hash TEXT NOT NULL, org_id TEXT, user_id TEXT, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, session_ref, message_id, revision)
);`

function harness() {
  const sqlite = new Database(":memory:")
  sqlite.exec(schema)
  const db = drizzle({ client: sqlite })
  const database = {
    use: <T>(callback: (client: typeof db) => T) => callback(db),
    transaction: <T>(callback: (client: typeof db) => T) =>
      (db.transaction as unknown as (run: (client: typeof db) => T) => T)(callback),
  }
  return { sqlite, ledger: createSqliteUsageLedger({ database: database as never, now: () => 5_000 }) }
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
    expect(sqlite.prepare("SELECT revision, state FROM claxedo_usage_outbox ORDER BY revision").all()).toEqual([
      { revision: 1, state: "pending" },
      { revision: 2, state: "pending" },
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
    expect(sqlite.prepare("SELECT count(*) AS count FROM claxedo_usage_outbox").get()).toEqual({ count: 2 })
  })

  test("isolates the same provider message id by canonical session ref", async () => {
    const { ledger } = harness()
    await ledger.writeRevision(revision())
    await ledger.writeRevision(revision({ sessionRef: "local:project-b:session:same-session" }))
    expect(await ledger.current()).toHaveLength(2)
  })

  test("reopens current facts and pending delivery without process memory", async () => {
    const { sqlite, ledger } = harness()
    const fact = revision()
    await ledger.writeRevision(fact)
    const db = drizzle({ client: sqlite })
    const reopened = createSqliteUsageLedger({
      database: {
        use: <T>(callback: (client: typeof db) => T) => callback(db),
        transaction: <T>(callback: (client: typeof db) => T) =>
          (db.transaction as unknown as (run: (client: typeof db) => T) => T)(callback),
      } as never,
    })
    expect(await reopened.current()).toEqual([fact])
    expect(await reopened.pendingOutbox()).toEqual([fact])
  })

  test("binds pending turns to the owner stamped at creation, never to the requester", async () => {
    const { sqlite, ledger } = harness()
    const accountA = { org_id: "org-a", user_id: "user-a" }
    const accountB = { org_id: "org-b", user_id: "user-b" }
    await ledger.writeRevision(revision(), { owner: accountA })

    // The other account's flush — even one allowed to adopt unowned machine
    // facts — cannot move a fact already owned by its producer.
    expect(await ledger.claimPending(accountB, { claimUnowned: true })).toEqual([])
    expect(
      sqlite
        .prepare("SELECT org_id, user_id FROM claxedo_usage_outbox WHERE revision = 1")
        .get(),
    ).toEqual({ org_id: "org-a", user_id: "user-a" })

    const final = revision({ revision: 2, settlement: "final", status: "completed" })
    await ledger.writeRevision(final, { owner: accountA })
    expect(await ledger.claimPending(accountB, { claimUnowned: true })).toEqual([])
    expect(await ledger.claimPending(accountA)).toEqual([revision(), final])
  })

  test("keeps a producer-owned fact with its owner when two accounts race to claim it", async () => {
    const { ledger } = harness()
    const accountA = { org_id: "org-a", user_id: "user-a" }
    const accountB = { org_id: "org-b", user_id: "user-b" }
    await ledger.writeRevision(revision(), { owner: accountA })

    // Order does not matter: the fact is A's before either flush runs, so
    // B's earlier claim changes nothing for it.
    expect(await ledger.claimPending(accountB, { claimUnowned: true })).toEqual([])
    expect(await ledger.claimPending(accountA)).toEqual([revision()])
  })

  test("unowned machine facts stay unowned until an operator flush adopts them", async () => {
    const { sqlite, ledger } = harness()
    const accountA = { org_id: "org-a", user_id: "user-a" }
    const accountB = { org_id: "org-b", user_id: "user-b" }
    await ledger.writeRevision(revision())

    // A member's flush sees nothing and assigns nothing: the fact has no
    // producing account and does not become the requester's.
    expect(await ledger.claimPending(accountB)).toEqual([])
    expect(await ledger.claimPending(accountA)).toEqual([])
    expect(
      sqlite.prepare("SELECT org_id, user_id FROM claxedo_usage_outbox").get(),
    ).toEqual({ org_id: null, user_id: null })

    // The operator's flush adopts the machine's fact — under the operator's
    // own identity — and later revisions inherit that binding.
    expect(await ledger.claimPending(accountA, { claimUnowned: true })).toEqual([revision()])
    const final = revision({ revision: 2, settlement: "final", status: "completed" })
    await ledger.writeRevision(final)
    expect(await ledger.claimPending(accountB, { claimUnowned: true })).toEqual([])
    expect(await ledger.claimPending(accountA)).toEqual([revision(), final])
  })

  test("scopes pending reads to the requesting owner", async () => {
    const { ledger } = harness()
    const accountA = { org_id: "org-a", user_id: "user-a" }
    const accountB = { org_id: "org-b", user_id: "user-b" }
    await ledger.writeRevision(revision({ messageId: "a-fact" }), { owner: accountA })
    await ledger.writeRevision(revision({ messageId: "b-fact" }), { owner: accountB })
    await ledger.writeRevision(revision({ messageId: "machine-fact" }))

    expect((await ledger.pendingOutbox({ all: true, owner: accountA })).map((item) => item.messageId)).toEqual([
      "a-fact",
    ])
    expect((await ledger.pendingOutbox({ all: true })).map((item) => item.messageId)).toEqual([
      "a-fact",
      "b-fact",
      "machine-fact",
    ])
  })

  test("rolls back the fact when enqueue fails", async () => {
    const { sqlite, ledger } = harness()
    sqlite.exec(
      `CREATE TRIGGER fail_usage_outbox BEFORE INSERT ON claxedo_usage_outbox BEGIN SELECT RAISE(FAIL, 'outbox down'); END`,
    )
    await expect(ledger.writeRevision(revision())).rejects.toThrow("outbox down")
    expect(sqlite.prepare("SELECT count(*) AS count FROM claxedo_usage_turn_revision").get()).toEqual({ count: 0 })
    expect(sqlite.prepare("SELECT count(*) AS count FROM claxedo_usage_turn_current").get()).toEqual({ count: 0 })
  })

  test("the persisted and uploadable fact has no content or secret fields", async () => {
    const { ledger } = harness()
    await ledger.writeRevision(revision())
    const encoded = JSON.stringify((await ledger.pendingOutbox())[0])
    for (const forbidden of ["prompt", "response", "directory", "credential", "auth", "apiKey"]) {
      expect(encoded).not.toContain(forbidden)
    }
  })

  test("persists provider-native identity for overlap classification", async () => {
    const { ledger } = harness()
    await ledger.writeRevision(revision({ nativeSessionId: "provider-thread-1" }))
    expect((await ledger.current())[0]?.nativeSessionId).toBe("provider-thread-1")
  })

  test("bounds current and pending reads to the requested inclusive range", async () => {
    const { ledger } = harness()
    await ledger.writeRevision(revision({ messageId: "before", observedAt: 999 }))
    await ledger.writeRevision(revision({ messageId: "start", observedAt: 1_000 }))
    await ledger.writeRevision(revision({ messageId: "end", observedAt: 2_000 }))
    await ledger.writeRevision(revision({ messageId: "after", observedAt: 2_001 }))

    expect((await ledger.current({ since: 1_000, until: 2_000 })).map((item) => item.messageId)).toEqual([
      "start",
      "end",
    ])
    expect(
      (await ledger.pendingOutbox({ since: 1_000, until: 2_000, all: true })).map((item) => item.messageId),
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
