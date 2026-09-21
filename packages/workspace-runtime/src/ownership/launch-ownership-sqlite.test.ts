import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { reconcileLaunch, type CreationIdentity, type RetirementResult } from "@claxedo/agent-sdk-runtime/launch"
import { migrateLaunchOwnership, sqliteLaunchOwnership, type SqliteDatabase } from "./launch-ownership-sqlite"

function store() {
  const db = new Database(":memory:") as unknown as SqliteDatabase
  migrateLaunchOwnership(db)
  return { db, ownership: sqliteLaunchOwnership(db) }
}

const identity: CreationIdentity = {
  pid: 4242,
  processGroupId: 4242,
  parentPid: 4241,
  startSecond: "Sun Sep 21 12:00:00 2026",
  bootTime: "1758000000",
  source: "darwin-ps",
}

const cleared: RetirementResult = { leader: "exited", descendants: "unknown", signals: [] }

test("the prepared row exists before anything is spawned", async () => {
  const { ownership } = store()
  const prepared = await ownership.prepare({
    role: "harness",
    protocol: "gate",
    parentOwnerId: "owner-1",
    scope: { workspaceId: "ws", sessionId: "s1", directory: "/tmp/p" },
  })
  const record = await ownership.read(prepared.launchId)

  expect(record).toEqual({
    launchId: prepared.launchId,
    role: "harness",
    protocol: "gate",
    parentOwnerId: "owner-1",
    scope: { workspaceId: "ws", sessionId: "s1", directory: "/tmp/p" },
    preparedAt: prepared.preparedAt,
  })
  expect(reconcileLaunch(record!).execution).toBe("none")
})

test("activation authorization is durable before the gate could have been told", async () => {
  const { db, ownership } = store()
  const prepared = await ownership.prepare({ role: "harness", protocol: "gate", scope: {} })
  await ownership.recordIdentity(prepared.launchId, identity, "nonce-1")
  await ownership.authorizeActivation(prepared.launchId)

  const row = db
    .prepare<{ activation_authorized_at: number | null; activation_acknowledged_at: number | null }>(
      "SELECT activation_authorized_at, activation_acknowledged_at FROM launch_ownership WHERE launch_id = ?",
    )
    .get(prepared.launchId)
  expect(row?.activation_authorized_at).toBeGreaterThan(0)
  expect(row?.activation_acknowledged_at).toBeNull()
  expect(reconcileLaunch((await ownership.read(prepared.launchId))!).execution).toBe("unknown")
})

test("a launch whose cleanup is unresolved is retained for a later owner", async () => {
  const { ownership } = store()
  const prepared = await ownership.prepare({ role: "managed-process", protocol: "gate", scope: { directory: "/tmp/p" } })
  await ownership.recordIdentity(prepared.launchId, identity, "nonce-1")
  await ownership.authorizeActivation(prepared.launchId)
  await ownership.acknowledgeActivation(prepared.launchId)

  const unresolved: RetirementResult = {
    leader: "alive",
    descendants: "owned",
    signals: [{ signal: "SIGKILL", scope: "group", delivered: false, refusal: "permission_denied" }],
    error: { code: "signal_denied", message: "denied" },
  }
  await ownership.recordRetirement(prepared.launchId, unresolved)

  const open = await ownership.listUnresolved({ directory: "/tmp/p" })
  expect(open.map((item) => item.launchId)).toEqual([prepared.launchId])
  expect(open[0]?.cleanup).toEqual(unresolved)
  expect(open[0]?.identity).toEqual(identity)

  await ownership.recordRetirement(prepared.launchId, cleared)
  expect(await ownership.listUnresolved({ directory: "/tmp/p" })).toEqual([])
})

test("a leader that exited over a group it still owns stays unresolved", async () => {
  const { ownership } = store()
  const prepared = await ownership.prepare({ role: "harness", protocol: "gate", scope: {} })
  await ownership.recordIdentity(prepared.launchId, identity, "nonce-1")
  await ownership.recordRetirement(prepared.launchId, { leader: "exited", descendants: "owned", signals: [] })

  expect((await ownership.listUnresolved()).map((item) => item.launchId)).toEqual([prepared.launchId])
})

test("unresolved launches are listed per scope, not globally", async () => {
  const { ownership } = store()
  const mine = await ownership.prepare({ role: "terminal", protocol: "direct", scope: { sessionId: "s1" } })
  await ownership.prepare({ role: "terminal", protocol: "direct", scope: { sessionId: "s2" } })

  expect((await ownership.listUnresolved({ sessionId: "s1" })).map((item) => item.launchId)).toEqual([mine.launchId])
  expect((await ownership.listUnresolved()).length).toBe(2)
})

test("migration is idempotent and keeps existing rows", async () => {
  const { db, ownership } = store()
  const prepared = await ownership.prepare({ role: "harness", protocol: "gate", scope: {} })
  migrateLaunchOwnership(db)
  expect((await ownership.read(prepared.launchId))?.launchId).toBe(prepared.launchId)
})

test("writing against a launch id nothing prepared is an error, not a silent no-op", async () => {
  const { ownership } = store()
  await expect(ownership.authorizeActivation("absent")).rejects.toThrow(/No prepared launch/)
})
