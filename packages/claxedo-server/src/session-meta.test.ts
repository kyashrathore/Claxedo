import { afterAll, afterEach, describe, expect, test } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `session-meta-test-${randomUUID().slice(0, 8)}`)
const prev = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}

process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const [{ applySessionMeta, deleteSessionMeta, putSessionMeta, sessionMeta, syncSessionMetas, taggedSessionMetas }, { ClaxedoDB }] = await Promise.all([
  import("./session-meta"),
  import("./storage/db"),
])

afterEach(async () => {
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
})

afterAll(() => {
  process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
})

describe("session meta", () => {
  test("syncs lineage and merges tags with attachments", async () => {
    await fs.mkdir(root, { recursive: true })
    const ws = {
      id: "ws_1",
      project_id: "proj_1",
      directory: "/tmp/repo",
      kind: "local" as const,
      created_at: 1,
      updated_at: 1,
    }

    await syncSessionMetas(ws, [
      {
        id: "root",
        title: "Root",
        time: { created: 10, updated: 12 },
      },
      {
        id: "child",
        title: "Child",
        parentID: "root",
        time: { created: 11, updated: 13 },
      },
    ])

    await putSessionMeta("child", {
      tags: ["review", "planner"],
      attachments: [
        { kind: "review", targetID: "rev_1" },
        { kind: "planner", targetID: "wg_1" },
      ],
    })

    const hit = await sessionMeta("child")
    expect(hit).toMatchObject({
      sessionID: "child",
      projectID: "proj_1",
      directory: "/tmp/repo",
      parentID: "root",
      rootID: "root",
      tags: ["planner", "review"],
      attachments: [
        { kind: "planner", targetID: "wg_1" },
        { kind: "review", targetID: "rev_1" },
      ],
    })

    const rows = await applySessionMeta([
      {
        id: "root",
        title: "Root",
        directory: "/tmp/repo",
        time: { created: 10, updated: 12 },
      },
      {
        id: "child",
        title: "Child",
        directory: "/tmp/repo",
        time: { created: 11, updated: 13 },
      },
    ])

    expect(rows).toEqual([
      {
        id: "root",
        title: "Root",
        directory: "/tmp/repo",
        time: { created: 10, updated: 12 },
        projectID: "proj_1",
        rootID: "root",
        tags: [],
        attachments: [],
      },
      {
        id: "child",
        title: "Child",
        directory: "/tmp/repo",
        time: { created: 11, updated: 13 },
        projectID: "proj_1",
        parentID: "root",
        rootID: "root",
        tags: ["planner", "review"],
        attachments: [
          { kind: "planner", targetID: "wg_1" },
          { kind: "review", targetID: "rev_1" },
        ],
      },
    ])
  })

  test("deletes metadata rows and associations with the session", async () => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("sess", {
      tags: ["review"],
      attachments: [{ kind: "review", targetID: "rev_1" }],
    })

    expect(await sessionMeta("sess")).toBeTruthy()
    await deleteSessionMeta("sess")
    expect(await sessionMeta("sess")).toBeUndefined()
  })

  test("lists tagged global sessions and keeps hidden ones out of default view", async () => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("visible", {
      directory: "/tmp/global/visible",
      title: "Visible",
      tags: ["global", "global:default"],
    })
    await putSessionMeta("hidden", {
      directory: "/tmp/global/hidden",
      title: "Hidden",
      tags: ["global"],
    })

    expect((await taggedSessionMetas(["global"])).map((item) => item.sessionID)).toEqual(["visible"])
    expect((await taggedSessionMetas(["global"], { includeHidden: true })).map((item) => item.sessionID)).toEqual([
      "hidden",
      "visible",
    ])
  })
})
