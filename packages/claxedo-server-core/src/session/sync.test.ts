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

const [{ syncCloudMessages }, { ClaxedoDB }, { ClaxedoCloudMessageTable }] = await Promise.all([
  import("./sync"),
  import("../platform/db"),
  import("./cloud.sql"),
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
  test("mirrors cloud session messages into claxedo.db", async () => {
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

    await syncCloudMessages(ws, "sess_1", [
      { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
    ])

    const messages = ClaxedoDB.use((db) => db.select().from(ClaxedoCloudMessageTable).all())

    expect(messages.map((item) => item.message_id)).toEqual(["msg_1", "msg_2"])
    expect(messages.map((item) => item.role)).toEqual(["user", "assistant"])
  })
})
