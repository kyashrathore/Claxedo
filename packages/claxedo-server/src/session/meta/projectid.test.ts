import { afterAll, afterEach, describe, expect, test } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `session-meta-projectid-${randomUUID().slice(0, 8)}`)
const prev = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}

process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const [{ applySessionMeta, syncSessionMetas }, { ClaxedoDB }] = await Promise.all([
  import("./index"),
  import("../../adapters/storage/db"),
])

afterEach(async () => {
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
})

afterAll(() => {
  process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
})

describe("applySessionMeta projectID canonicalization", () => {
  test("prefers canonical stored projectID over conflicting source projectID", async () => {
    await fs.mkdir(root, { recursive: true })
    const ws = {
      id: "ws_1",
      project_id: "proj_canonical",
      directory: "/tmp/repo",
      kind: "local" as const,
      created_at: 1,
      updated_at: 1,
    }

    await syncSessionMetas(ws, [
      {
        id: "ses_wrong_project",
        title: "Wrong Project",
        time: { created: 10, updated: 12 },
      },
    ])

    const [row] = await applySessionMeta([
      {
        id: "ses_wrong_project",
        title: "Wrong Project",
        directory: "/tmp/repo",
        projectID: "proj_source_wrong",
        time: { created: 10, updated: 12 },
      },
    ])

    expect(row).toMatchObject({
      id: "ses_wrong_project",
      projectID: "proj_canonical",
      rootID: "ses_wrong_project",
    })
  })
})
