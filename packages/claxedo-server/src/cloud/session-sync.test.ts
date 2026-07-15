import { afterEach, beforeEach, describe, expect, test } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(os.tmpdir(), `cloud-session-sync-test-${randomUUID().slice(0, 8)}`)
const prev = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}

process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const [{ syncCloudMessages, syncCloudSession, syncCloudSessions, deleteCloudSession }, { ClaxedoDB }, { ClaxedoCloudMessageTable, ClaxedoCloudSessionTable }] = await Promise.all([
  import("./session-sync"),
  import("../storage/db"),
  import("../storage/cloud-session.sql"),
])

beforeEach(() => {
  process.env.CLAXEDO_DATA_DIR = root
  process.env.CLAXEDO_STATE_DIR = path.join(root, "state")
})

afterEach(async () => {
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
  if (prev.CLAXEDO_DATA_DIR === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
  if (prev.CLAXEDO_STATE_DIR === undefined) delete process.env.CLAXEDO_STATE_DIR
  else process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
})

describe("cloud session sync", () => {
  test("mirrors cloud session summaries and messages into claxedo.db", async () => {
    await fs.mkdir(root, { recursive: true })
    const ws = {
      id: "ws_cloud",
      project_id: "ws_cloud",
      directory: "/tmp/cloud",
      kind: "cloud" as const,
      driver: "daytona" as const,
      repo_name: "opencode",
      git_branch: "main",
      git_remote: "git@github.com:foo/opencode.git",
      created_at: 1,
      updated_at: 1,
    }

    await syncCloudSession(ws, {
      id: "sess_1",
      title: "Cloud chat",
      time: { created: 11, updated: 12 },
    })

    await syncCloudMessages(ws, "sess_1", [
      { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
    ])

    const sessions = ClaxedoDB.use((db) => db.select().from(ClaxedoCloudSessionTable).all())
    const messages = ClaxedoDB.use((db) => db.select().from(ClaxedoCloudMessageTable).all())

    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.session_id).toBe("sess_1")
    expect(sessions[0]?.driver).toBe("daytona")
    expect(sessions[0]?.project_id).toBe("ws_cloud")
    expect(sessions[0]?.repo_name).toBe("opencode")
    expect(sessions[0]?.git_branch).toBe("main")
    expect(sessions[0]?.git_remote).toBe("git@github.com:foo/opencode.git")
    expect(messages.map((item) => item.message_id)).toEqual(["msg_1", "msg_2"])
    expect(messages.map((item) => item.role)).toEqual(["user", "assistant"])

    await deleteCloudSession(ws, "sess_1")

    const gone = ClaxedoDB.use((db) => db.select().from(ClaxedoCloudSessionTable).all())
    const cleared = ClaxedoDB.use((db) => db.select().from(ClaxedoCloudMessageTable).all())

    expect(gone[0]?.deleted_at).toBeTruthy()
    expect(cleared).toHaveLength(0)
  })

  test("marks missing cloud sessions deleted when a fresh list no longer includes them", async () => {
    await fs.mkdir(root, { recursive: true })
    const ws = {
      id: "ws_cloud",
      project_id: "ws_cloud",
      directory: "/tmp/cloud",
      kind: "cloud" as const,
      driver: "daytona" as const,
      repo_name: "opencode",
      git_branch: "main",
      git_remote: "git@github.com:foo/opencode.git",
      created_at: 1,
      updated_at: 1,
    }

    await syncCloudSession(ws, {
      id: "sess_old",
      title: "Old chat",
      time: { created: 11, updated: 12 },
    })
    await syncCloudMessages(ws, "sess_old", [
      { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
    ])

    await syncCloudSessions(ws, [
      {
        id: "sess_new",
        title: "New chat",
        time: { created: 21, updated: 22 },
      },
    ])

    const sessions = ClaxedoDB.use((db) => db.select().from(ClaxedoCloudSessionTable).all())
    const messages = ClaxedoDB.use((db) => db.select().from(ClaxedoCloudMessageTable).all())
    const old = sessions.find((item) => item.session_id === "sess_old")
    const next = sessions.find((item) => item.session_id === "sess_new")

    expect(next?.deleted_at).toBeNull()
    expect(old?.deleted_at).toBeTruthy()
    expect(messages).toHaveLength(0)
  })

  test("requires canonical workspace driver before writing the session driver column", async () => {
    await fs.mkdir(root, { recursive: true })
    const ws = {
      id: "ws_legacy_cloud",
      project_id: "ws_legacy_cloud",
      directory: "/tmp/cloud",
      kind: "cloud" as const,
      provider: "daytona",
      created_at: 1,
      updated_at: 1,
    }

    await syncCloudSession(ws as unknown as Parameters<typeof syncCloudSession>[0], {
      id: "sess_legacy",
      title: "Legacy cloud chat",
      time: { created: 11, updated: 12 },
    })

    const sessions = ClaxedoDB.use((db) => db.select().from(ClaxedoCloudSessionTable).all())
    expect(sessions[0]?.driver).toBeNull()
  })
})
