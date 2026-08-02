import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `control-plane-durable-state-${randomUUID().slice(0, 8)}`)
const prev = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}

process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const [{ createSqliteCentralStore }, , , { ClaxedoDB }, { createProjectionDedupStore }] = await Promise.all([
  import("./adapters/sqlite/central-store"),
  import("./projection-store"),
  import("./durable-session-log"),
  import("../storage/db"),
  import("../channels-dedup"),
])

async function nativeSqliteAvailable() {
  if ("bun" in process.versions) return false
  try {
    const mod = await import("better-sqlite3")
    const db = new mod.default(":memory:")
    db.close()
    return true
  } catch {
    return false
  }
}

const sqliteTest = await nativeSqliteAvailable() ? test : test.skip

function sync() {
  return createSqliteCentralStore({ mode: () => "central_canonical" })
}

beforeEach(async () => {
  await fs.mkdir(root, { recursive: true })
})

afterEach(async () => {
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
})

afterAll(() => {
  if (prev.CLAXEDO_DATA_DIR !== undefined) process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
  else delete process.env.CLAXEDO_DATA_DIR
  if (prev.CLAXEDO_STATE_DIR !== undefined) process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
  else delete process.env.CLAXEDO_STATE_DIR
})

describe("control plane durable state", () => {
  sqliteTest("session metadata and replay events survive service recreation", async () => {
    const projectionStore = sync().projectionStore
    const sessionLog = sync().durableSessionLog

    await projectionStore.put_session_meta("session-restart", {
      directory: "/tmp/restart-workspace",
      title: "Persistent session",
      tags: ["review"],
      attachments: [{ kind: "review", targetID: "review_1" }],
    })
    sessionLog.persist_message_event("session-restart", {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_restart",
          sessionID: "session-restart",
          role: "assistant",
        },
      },
    })
    sessionLog.persist_message_event("session-restart", {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_restart",
          sessionID: "session-restart",
          messageID: "msg_restart",
          type: "text",
          text: "survived restart",
        },
      },
    })

    ClaxedoDB.close()

    const restartedStore = sync().projectionStore
    await expect(restartedStore.session_meta("session-restart")).resolves.toMatchObject({
      sessionID: "session-restart",
      directory: "/tmp/restart-workspace",
      title: "Persistent session",
      tags: ["review"],
      attachments: [{ kind: "review", targetID: "review_1" }],
    })
    expect(restartedStore.read_session_messages("session-restart")).toEqual([{
      info: {
        id: "msg_restart",
        sessionID: "session-restart",
        role: "assistant",
      },
      parts: [{
        id: "part_restart",
        sessionID: "session-restart",
        messageID: "msg_restart",
        type: "text",
        text: "survived restart",
      }],
    }])
    expect(restartedStore.read_session_max_event_ordinal("session-restart")).toBe(2)
  })

  sqliteTest("channel delivery dedup survives service recreation", async () => {
    const envelope = {
      channel: "telegram" as const,
      externalUserId: "owner",
      threadKey: "telegram:test:chat:thread",
      idempotencyKey: "delivery-restart",
      text: "hello",
      receivedAt: 1_000_000,
      raw: {},
    }
    const dedup = createProjectionDedupStore(sync().projectionStore)

    await expect(dedup.claim(envelope, { now: 1_000_000 })).resolves.toEqual({
      ok: true,
      duplicate: false,
    })
    await dedup.rememberSession(envelope, "session-restart")

    ClaxedoDB.close()

    const restarted = createProjectionDedupStore(sync().projectionStore)
    await expect(restarted.claim(envelope, { now: 1_000_100 })).resolves.toEqual({
      ok: true,
      duplicate: true,
      sessionId: "session-restart",
    })
  })

  sqliteTest("channel delivery daily ceiling is durable", async () => {
    const dedup = createProjectionDedupStore(sync().projectionStore, { dailyCeiling: 1 })
    const envelope = {
      channel: "telegram" as const,
      externalUserId: "owner",
      threadKey: "telegram:test:chat:thread",
      idempotencyKey: "delivery-1",
      text: "hello",
      receivedAt: 1_000_000,
      raw: {},
    }

    await expect(dedup.claim(envelope, { now: 1_000_000, reserveSessionCreate: true })).resolves.toMatchObject({
      ok: true,
      duplicate: false,
    })
    await expect(dedup.countByChannelUserDay({
      channel: "telegram",
      externalUserId: "owner",
      day: "1970-01-01",
    })).resolves.toBe(1)
    await dedup.rememberSession(envelope, "session-ceiling-1", { sessionCreate: true })
    await expect(dedup.claim({ ...envelope, idempotencyKey: "delivery-2" }, { now: 1_000_001 })).resolves.toMatchObject({
      ok: true,
      duplicate: false,
    })
    await expect(dedup.claim({ ...envelope, idempotencyKey: "delivery-3" }, {
      now: 1_000_002,
      reserveSessionCreate: true,
    })).resolves.toMatchObject({
      ok: false,
      reason: "daily_ceiling_exceeded",
    })
  })

  sqliteTest("channel delivery release allows failed pre-run delivery to retry", async () => {
    const dedup = createProjectionDedupStore(sync().projectionStore)
    const envelope = {
      channel: "telegram" as const,
      externalUserId: "owner",
      threadKey: "telegram:test:chat:thread",
      idempotencyKey: "delivery-release",
      text: "hello",
      receivedAt: 1_000_000,
      raw: {},
    }

    await expect(dedup.claim(envelope, { now: 1_000_000, reserveSessionCreate: true })).resolves.toEqual({
      ok: true,
      duplicate: false,
    })
    await dedup.release(envelope)
    await expect(dedup.claim(envelope, { now: 1_000_001, reserveSessionCreate: true })).resolves.toEqual({
      ok: true,
      duplicate: false,
    })
  })

  sqliteTest("channel delivery accepts first live delayed delivery but rejects pre-watermark deliveries", async () => {
    const dedup = createProjectionDedupStore(sync().projectionStore)

    await expect(dedup.claim({
      channel: "github",
      externalUserId: "octo",
      threadKey: "github:install:repo:issue-1",
      idempotencyKey: "first-live-delayed",
      text: "@claxedo hello",
      receivedAt: 999_999,
      raw: {},
    }, { now: 1_000_000 })).resolves.toMatchObject({
      ok: true,
      duplicate: false,
    })

    await expect(dedup.claim({
      channel: "github",
      externalUserId: "octo",
      threadKey: "github:install:repo:issue-1",
      idempotencyKey: "pre-watermark",
      text: "@claxedo hello",
      receivedAt: 1_000_000 - 24 * 60 * 60 * 1000 - 1,
      raw: {},
    }, { now: 1_000_000 })).resolves.toMatchObject({
      ok: false,
      reason: "stale_delivery",
    })
  })

  sqliteTest("channel run audit survives service recreation", async () => {
    const projectionStore = sync().projectionStore

    await projectionStore.record_channel_run_audit?.({
      sessionId: "session-channel-audit",
      channel: "github",
      externalUserId: "octo",
      threadKey: "github:42:acme/repo:pr-7",
      workspaceId: "acme/repo",
      cost: null,
      createdAt: 1_000_000,
    })

    ClaxedoDB.close()

    const restartedStore = sync().projectionStore
    await expect(restartedStore.channel_run_audit?.({ sessionId: "session-channel-audit" })).resolves.toEqual({
      sessionId: "session-channel-audit",
      channel: "github",
      externalUserId: "octo",
      threadKey: "github:42:acme/repo:pr-7",
      workspaceId: "acme/repo",
      cost: null,
      createdAt: 1_000_000,
    })
    await expect(restartedStore.channel_run_audits?.({ channel: "github" })).resolves.toEqual([{
      sessionId: "session-channel-audit",
      channel: "github",
      externalUserId: "octo",
      threadKey: "github:42:acme/repo:pr-7",
      workspaceId: "acme/repo",
      cost: null,
      createdAt: 1_000_000,
    }])
  })

  sqliteTest("channel session reset survives service recreation without erasing audit history", async () => {
    const projectionStore = sync().projectionStore
    const threadKey = "telegram:test:reset:thread"

    await projectionStore.record_channel_run_audit?.({
      sessionId: "session-before-reset",
      channel: "telegram",
      externalUserId: "owner",
      threadKey,
      cost: null,
      createdAt: 1_000_000,
    })
    await expect(projectionStore.channel_thread_session?.({ threadKey })).resolves.toBe("session-before-reset")

    await projectionStore.clear_channel_thread_session?.({ threadKey })
    await expect(projectionStore.channel_thread_session?.({ threadKey })).resolves.toBeUndefined()

    ClaxedoDB.close()

    const restartedStore = sync().projectionStore
    await expect(restartedStore.channel_thread_session?.({ threadKey })).resolves.toBeUndefined()
    await expect(restartedStore.channel_run_audits?.({ threadKey })).resolves.toEqual([{
      sessionId: "session-before-reset",
      channel: "telegram",
      externalUserId: "owner",
      threadKey,
      workspaceId: null,
      cost: null,
      createdAt: 1_000_000,
    }])

    await restartedStore.record_channel_run_audit?.({
      sessionId: "session-after-reset",
      channel: "telegram",
      externalUserId: "owner",
      threadKey,
      cost: null,
      createdAt: 2_000_000,
    })
    await expect(restartedStore.channel_thread_session?.({ threadKey })).resolves.toBe("session-after-reset")
    await restartedStore.clear_channel_thread_session?.({ threadKey, sessionId: "session-before-reset" })
    await expect(restartedStore.channel_thread_session?.({ threadKey })).resolves.toBe("session-after-reset")
    await expect(restartedStore.channel_run_audits?.({ threadKey })).resolves.toEqual([
      {
        sessionId: "session-after-reset",
        channel: "telegram",
        externalUserId: "owner",
        threadKey,
        workspaceId: null,
        cost: null,
        createdAt: 2_000_000,
      },
      {
        sessionId: "session-before-reset",
        channel: "telegram",
        externalUserId: "owner",
        threadKey,
        workspaceId: null,
        cost: null,
        createdAt: 1_000_000,
      },
    ])
  })
})
